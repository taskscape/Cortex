/**
 * Runtime-admin package-manager runner.
 *
 * Installing or removing a plugin package shells out to the project's package manager. This test
 * ensures that the runner can never take the process down or hold a tool call open:
 * - A command that cannot be started rejects (previously: no `error` listener, so an uncaught
 *   exception for the whole process and a promise that never settled)
 * - Cancelling the tool call kills the command, including what it started
 * - A command that outlives its time limit is killed and reported as timed out
 * - A normal command still returns its output
 *
 * It also ensures the specifier can never be read as shell syntax. npm/pnpm/yarn are `.cmd` shims
 * on Windows, which only cmd.exe can run, and the runner used `shell: true`, which joins arguments
 * into the command line unescaped:
 * - Arguments reach a `.cmd` shim verbatim: `left-pad & calc` is one inert argument, and ordinary
 *   specifiers are no longer rewritten (`pkg@^1.2.3` lost its caret; a URL was cut at its `&`)
 * - What quoting cannot neutralise (`"`, `%`, `!`, control characters) is refused before anything
 *   is started
 * - `plugin add` refuses an unsafe specifier before the user is asked to confirm it
 *
 * Assumptions:
 * - `node` is on PATH (the runner resolves commands through PATH, via cmd.exe on Windows)
 * - Helper scripts are addressed relative to the working directory, so no quoting is involved
 * - The shim tests are Windows-only; they stand a copy of npm's own cmd-shim wrapper in front of
 *   an argv-echo script and put it first on PATH, so no real package manager or network is used
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

await import("../local-agent/matbot/apps/cli/register.js");
const { runCommand, commandLaunch, packageSpecifierHazard, pluginTool } = await import("../local-agent/matbot/packages/plugins/runtime-admin/src/plugin.ts");

process.on("uncaughtException", error => { throw error; });

const onWindows = process.platform === "win32";

// The wrapper npm's cmd-shim writes for pnpm/yarn (and structurally what npm.cmd ends with): the
// arguments are re-expanded through `%*` on a second cmd.exe parse.
const CMD_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\echo-args.cjs" %*
`.replace(/\r?\n/g, "\r\n");

/** Runs `run(dir)` with a fake package manager named `name` first on PATH; it prints its argv. */
async function withFakePackageManager(name, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "cortex-fake-pm-"));
  const savedPath = process.env.PATH;
  try {
    await writeFile(path.join(dir, `${name}.cmd`), CMD_SHIM);
    await writeFile(path.join(dir, "echo-args.cjs"), "process.stdout.write('ARGV=' + JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    process.env.PATH = dir + path.delimiter + savedPath;
    await run(dir);
  } finally {
    process.env.PATH = savedPath;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// Each would run `echo` as a second command — leaving canary.txt behind — if it were parsed as
// shell syntax; the last three are ordinary specifiers that the shell used to rewrite.
const SHELL_SYNTAX_SPECIFIERS = [
  "left-pad & echo pwned> canary.txt",
  "left-pad && echo pwned> canary.txt",
  "left-pad | echo pwned> canary.txt",
  "left-pad || echo pwned> canary.txt",
  "(left-pad) ; echo pwned> canary.txt",
  "pkg@^1.2.3",
  "pkg@>=1.0.0 <2.0.0",
  "https://example.com/plugin.tgz?token=a&echo=pwned>canary.txt",
];
// Breaks out of double quotes: `%CMDCMDLINE:~-1%` expands to a `"` before quotes are parsed.
const UNQUOTABLE_SPECIFIERS = [
  "left-pad%CMDCMDLINE:~-1%&echo pwned> canary.txt",
  "left-pad\" & echo pwned> canary.txt & \"",
  "left-pad!CMDCMDLINE:~-1!&echo pwned> canary.txt",
  "left-pad\r\necho pwned> canary.txt",
];

async function withScripts(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "cortex-runtime-admin-"));
  try {
    await writeFile(path.join(dir, "hello.mjs"), "console.log('installed ok');\n");
    await writeFile(path.join(dir, "hang.mjs"), "console.log('started'); setInterval(() => {}, 1000);\n");
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("a command that cannot be started rejects instead of crashing the process", async () => {
  const missing = path.join(tmpdir(), `cortex-missing-${Date.now()}`, "nope");
  await assert.rejects(() => runCommand("node", ["hello.mjs"], missing), /could not be started|exited with code/);
});

test("a normal command returns its combined output", async () => {
  await withScripts(async dir => {
    assert.match(await runCommand("node", ["hello.mjs"], dir), /installed ok/);
  });
});

test("cancelling the tool call kills a hung command", { timeout: 30_000 }, async () => {
  await withScripts(async dir => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runCommand("node", ["hang.mjs"], dir, controller.signal);
    setTimeout(() => controller.abort(), 500);
    await assert.rejects(() => pending, /was cancelled/);
    assert.ok(Date.now() - started < 15_000, "cancellation must not wait for the command's own exit");
  });
});

test("a command that outlives its time limit is killed", { timeout: 30_000 }, async () => {
  await withScripts(async dir => {
    await assert.rejects(() => runCommand("node", ["hang.mjs"], dir, undefined, 500), /timed out after/);
  });
});

test("on Windows the command line is assembled with every argument quoted, not handed to a shell", () => {
  const launch = commandLaunch("pnpm", ["add", "pkg@^1.2.3", "C:\dir\\"], "win32");
  assert.match(launch.file, /cmd(\.exe)?$/i);
  assert.deepEqual(launch.args, ["/d", "/s", "/c", '""pnpm" "add" "pkg@^1.2.3" "C:\dir\\\\""']);
  assert.deepEqual(launch.options, { windowsVerbatimArguments: true });

  // Elsewhere there is no shell in the way to begin with: the arguments are an argv, as given.
  const direct = commandLaunch("pnpm", ["add", "x%y\"z & w"], "linux");
  assert.deepEqual(direct, { file: "pnpm", args: ["add", "x%y\"z & w"], options: {} });
});

test("what quoting cannot neutralise on Windows is refused, not escaped", () => {
  for (const specifier of UNQUOTABLE_SPECIFIERS) {
    assert.throws(() => commandLaunch("pnpm", ["add", specifier], "win32"), /cannot be passed to a Windows command safely/, specifier);
  }
  assert.throws(() => commandLaunch("pn\"pm", ["add", "left-pad"], "win32"), /cannot be passed/);
});

test("specifiers are vetted for the package manager they are about to be handed to", () => {
  const ordinary = [
    "left-pad", "@scope/name", "@scope/name@1.2.3", "pkg@^1.2.3", "pkg@>=1.0.0 <2.0.0", "pkg@latest",
    "github:user/repo#path:packages/plugin", "git+https://github.com/user/repo.git#semver:^1.0.0",
    "https://example.com/plugin.tgz?a=1&b=2",
  ];
  for (const platform of ["win32", "linux", "darwin"]) {
    for (const specifier of ordinary) assert.equal(packageSpecifierHazard(specifier, platform), undefined, `${specifier} on ${platform}`);
    assert.match(packageSpecifierHazard("--registry=http://attacker.example", platform), /option/);
    assert.match(packageSpecifierHazard("-g", platform), /option/);
    assert.match(packageSpecifierHazard("left-pad\n  - ./local/code", platform), /control characters/);
  }
  for (const specifier of UNQUOTABLE_SPECIFIERS) assert.ok(packageSpecifierHazard(specifier, "win32"), specifier);
  // Only cmd.exe gives these meaning; a percent-encoded tarball URL is fine where no shell is involved.
  assert.match(packageSpecifierHazard("https://example.com/my%20plugin.tgz", "win32"), /contains %.*Windows/);
  assert.equal(packageSpecifierHazard("https://example.com/my%20plugin.tgz", "linux"), undefined);
});

test("arguments reach a Windows .cmd shim verbatim and never run as commands", { skip: !onWindows, timeout: 60_000 }, async () => {
  await withFakePackageManager("fakepm", async dir => {
    const canary = path.join(dir, "canary.txt");
    for (const specifier of [...SHELL_SYNTAX_SPECIFIERS, "trailing\\", ""]) {
      const output = await runCommand("fakepm", ["add", specifier], dir);
      assert.equal(output.trim(), `ARGV=${JSON.stringify(["add", specifier])}`, `argument was altered: ${specifier}`);
      assert.equal(existsSync(canary), false, `a second command ran for: ${specifier}`);
    }
    for (const specifier of UNQUOTABLE_SPECIFIERS) {
      await assert.rejects(() => runCommand("fakepm", ["add", specifier], dir), /cannot be passed to a Windows command safely/);
      assert.equal(existsSync(canary), false, `a second command ran for: ${specifier}`);
    }
  });
});

function pluginToolContext(configPath, calls) {
  return {
    configPath,
    signal: new AbortController().signal,
    vault: { async writeSecret() {} },
    async prompt(field) { calls.prompts.push(field); return "yes"; },
    async loadPlugin(specifier) { calls.loads.push(specifier); return {}; },
    async unloadPlugin() { return false; },
  };
}

async function pluginAdd(specifier, context) {
  const events = [];
  for await (const event of pluginTool.executor.execute({ action: "add", specifier }, context)) events.push(event);
  return events;
}

test("plugin add refuses an unsafe specifier before asking the user to confirm it", async t => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cortex-plugin-add-refuse-"));
  t.after(() => rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configPath = path.join(projectDir, "matbot.yaml");
  const config = "name: refuse-test\nplugins:\n  - ./existing\n";
  await writeFile(configPath, config, "utf8");
  const calls = { prompts: [], loads: [] };

  const refused = [
    ["--registry=http://attacker.example", /option/],
    ["left-pad\n  - ./local/code", /control characters/],
    // A newline in a remote specifier would otherwise be written into matbot.yaml as its own entry.
    ["https://example.com/plugin\n  - ./local/code", /control characters/],
    ...(onWindows ? UNQUOTABLE_SPECIFIERS.slice(0, 3).map(specifier => [specifier, /cannot be passed to a package manager safely on Windows/]) : []),
  ];
  for (const [specifier, reason] of refused) {
    const events = await pluginAdd(specifier, pluginToolContext(configPath, calls));
    const error = events.find(event => event.type === "error");
    assert.match(error?.message ?? "", /Refusing to install/, JSON.stringify(specifier));
    assert.match(error.message, reason, JSON.stringify(specifier));
  }
  assert.deepEqual(calls, { prompts: [], loads: [] }, "nothing may be confirmed or loaded for a refused specifier");
  assert.equal(await readFile(configPath, "utf8"), config);
  assert.equal(existsSync(path.join(projectDir, "canary.txt")), false);
});

test("plugin add hands a shell-syntax specifier to the package manager as one inert argument", { skip: !onWindows, timeout: 60_000 }, async t => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cortex-plugin-add-inert-"));
  t.after(() => rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configPath = path.join(projectDir, "matbot.yaml");
  await writeFile(configPath, "name: inert-test\n", "utf8");

  // No lockfile, so the tool picks npm — resolved here to the argv-echo shim.
  await withFakePackageManager("npm", async () => {
    for (const specifier of SHELL_SYNTAX_SPECIFIERS.slice(0, 5)) {
      const calls = { prompts: [], loads: [] };
      const events = await pluginAdd(specifier, pluginToolContext(configPath, calls));
      const stdout = events.filter(event => event.type === "stdout").map(event => event.chunk).join("");
      assert.ok(stdout.includes(`ARGV=${JSON.stringify(["add", specifier])}`), `package manager did not receive ${JSON.stringify(specifier)} intact:\n${stdout}\n${JSON.stringify(events)}`);
      assert.equal(calls.prompts.length, 1, "installation still requires confirmation");
      assert.equal(existsSync(path.join(projectDir, "canary.txt")), false, `a second command ran for: ${specifier}`);
    }
  });
});

test("the CLI installer applies the same rules as the tool", { timeout: 60_000 }, async t => {
  const { installPlugin } = await import("../local-agent/matbot/apps/cli/src/install.ts");
  const projectDir = await mkdtemp(path.join(tmpdir(), "cortex-cli-install-"));
  t.after(() => rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const configPath = path.join(projectDir, "matbot.yaml");
  const config = "name: cli-install-test\n";
  await writeFile(configPath, config, "utf8");

  await assert.rejects(() => installPlugin("--registry=http://attacker.example", configPath), /Cannot install .*option/);
  if (onWindows) {
    await assert.rejects(() => installPlugin(UNQUOTABLE_SPECIFIERS[0], configPath), /Cannot install .*Windows/);
  }
  assert.equal(await readFile(configPath, "utf8"), config, "a refused specifier must not reach matbot.yaml");

  if (!onWindows) return;
  await withFakePackageManager("npm", async () => {
    await installPlugin(SHELL_SYNTAX_SPECIFIERS[0], configPath);
    assert.equal(existsSync(path.join(projectDir, "canary.txt")), false, "a second command ran from `matbot install`");
  });
});

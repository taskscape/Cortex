import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const guidePath = path.join(root, "userguide.md");

function headingAnchor(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

async function anchorsFor(filePath) {
  const text = await readFile(filePath, "utf8");
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => headingAnchor(match[1]))
  );
}

test("E2E-023 user guide relative links and heading anchors resolve", async () => {
  const guide = await readFile(guidePath, "utf8");
  const links = [...guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
  assert.ok(links.length > 0, "expected userguide.md to contain links");

  for (const link of links) {
    if (/^[a-z]+:/i.test(link)) continue;
    const [rawTarget, anchor] = link.split("#", 2);
    const target = rawTarget ? path.resolve(root, decodeURIComponent(rawTarget)) : guidePath;
    await assert.doesNotReject(access(target), `missing user-guide link target: ${link}`);
    if (anchor) {
      const anchors = await anchorsFor(target);
      assert.ok(anchors.has(anchor), `missing heading #${anchor} in ${path.relative(root, target)}`);
    }
  }
});

test("user guide commands, port, and important WebUI labels match shipped files", async () => {
  const [guide, runScript, indexHtml, appJs] = await Promise.all([
    readFile(guidePath, "utf8"),
    readFile(path.join(root, "scripts", "run.ps1"), "utf8"),
    readFile(path.join(root, "local-agent", "matbot", "packages", "plugins", "frontend", "web", "static", "index.html"), "utf8"),
    readFile(path.join(root, "local-agent", "matbot", "packages", "plugins", "frontend", "web", "static", "app.js"), "utf8")
  ]);

  for (const relative of [
    "scripts/setup-secrets.ps1",
    "scripts/run.ps1",
    "scripts/health-check.ps1",
    "scripts/stop-local-agent.ps1"
  ]) {
    await assert.doesNotReject(access(path.join(root, relative)), `missing documented command ${relative}`);
  }

  const documentedPort = /http:\/\/localhost:(\d+)/.exec(guide)?.[1];
  const scriptPort = /\[int\]\$WebPort\s*=\s*(\d+)/.exec(runScript)?.[1];
  assert.equal(documentedPort, scriptPort, "documented WebUI port differs from run.ps1 default");

  for (const label of [
    "New conversation",
    "Model:",
    "Experts",
    "Save",
    "Close",
    "Sources",
    "SQL Preview",
    "Workflow Center",
    "Evaluation &amp; ROI",
    "Graph",
    "Reviews",
    "Approve",
    "Reject"
  ]) {
    assert.ok((indexHtml + appJs).includes(label), `shipped WebUI is missing documented label ${JSON.stringify(label)}`);
  }
});

test("user guide retains explicit product limitations and destructive warnings", async () => {
  const guide = await readFile(guidePath, "utf8");
  const normalizedGuide = guide.replace(/\s+/g, " ");

  for (const required of [
    "currently indexes Markdown files only",
    "does not expose a general scheduling screen",
    "editing a version diff are not implemented yet",
    "Manual reviewer assignment and status editing remain future product work"
  ]) {
    assert.ok(normalizedGuide.includes(required), `missing documented limitation: ${required}`);
  }

  const destructiveCommand = guide.indexOf("docker-compose.yml down -v");
  const destructiveWarning = guide.indexOf("This deletes the Docker-backed local memory databases.");
  assert.ok(destructiveCommand >= 0 && destructiveWarning > destructiveCommand, "volume deletion warning must follow the destructive command");
  assert.ok(destructiveWarning - destructiveCommand < 500, "volume deletion warning drifted too far from the destructive command");
});

test("user guide localhost safety boundary matches the production listener", async () => {
  const [guide, frontendPlugin] = await Promise.all([
    readFile(guidePath, "utf8"),
    readFile(path.join(
      root, "local-agent", "matbot", "packages", "plugins", "frontend", "web", "src", "plugin.ts"
    ), "utf8")
  ]);
  assert.match(guide, /WebUI is intended for localhost use/);
  assert.match(frontendPlugin, /WEB_LISTEN_HOST\s*=\s*['"]127\.0\.0\.1['"]/);
  assert.match(frontendPlugin, /server\.listen\(port,\s*WEB_LISTEN_HOST\)/);
  assert.doesNotMatch(frontendPlugin, /server\.listen\(port,\s*['"]0\.0\.0\.0['"]\)/);
});

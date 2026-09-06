import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConfig, parseYaml } from '@matatbread/matbot-config';
import type { MatbotConfig } from '@matatbread/matbot-config';

/** The parsed matbot configuration type, re-exported from the config package. */
export type { MatbotConfig };

/**
 * Parse config text and, when it declares `extends:`, read that base file from disk.
 * @param text - Raw YAML config text.
 * @param fromDir - Directory `extends:` paths resolve against; also the fallback project directory.
 * @returns The base config text (`undefined` when there is no `extends:`) and the project directory (the base file's directory when extending).
 * @throws Error - When the YAML fails to parse or the base file cannot be read.
 */
async function loadBase(
  text:    string,
  fromDir: string,
): Promise<{ baseText: string | undefined; projectDir: string }> {
  const doc = parseYaml(text);
  const ext = doc['extends'];
  if (typeof ext !== 'string') return { baseText: undefined, projectDir: fromDir };
  const basePath = path.resolve(fromDir, ext);
  const baseText = await readFile(basePath, 'utf8');
  return { baseText, projectDir: path.dirname(basePath) };
}

/**
 * Load and parse matbot.yaml from disk, honouring an `extends:` base config whose
 * directory becomes the project root.
 * @param configPath Path to the matbot.yaml file.
 * @returns The parsed config plus the project directory (the base config's dir when `extends:` is used).
 * @throws Error When the file cannot be read or the YAML fails to parse/validate.
 */
export async function loadConfig(
  configPath: string,
): Promise<{ config: MatbotConfig; projectDir: string }> {
  const text    = await readFile(configPath, 'utf8');
  const fromDir = path.dirname(configPath);
  const { baseText, projectDir } = await loadBase(text, fromDir);
  return { config: parseConfig(text, baseText), projectDir };
}

/**
 * Parse config text supplied directly (e.g. piped via stdin), honouring `extends:` the
 * same way {@link loadConfig} does.
 * @param text Raw YAML config text.
 * @param fromDir Directory `extends:` paths resolve against; defaults to the process cwd.
 * @returns The parsed config plus the project directory.
 * @throws Error When the base file cannot be read or parsing/validation fails.
 */
export async function loadConfigFromText(
  text:    string,
  fromDir: string = process.cwd(),
): Promise<{ config: MatbotConfig; projectDir: string }> {
  const { baseText, projectDir } = await loadBase(text, fromDir);
  return { config: parseConfig(text, baseText), projectDir };
}

/**
 * Parse `.env`-style text into a flat key/value record. Skips blank lines and `#` comment lines,
 * strips an optional `export ` prefix, removes matching surrounding quotes, and trims unquoted
 * values at the first inline comment (a whitespace-`#` sequence).
 * @param text - Raw .env file contents.
 * @returns Parsed variables in file order; later duplicate keys overwrite earlier ones.
 * @throws Never.
 */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const eq = stripped.indexOf('=');
    if (eq === -1) continue;
    const key = stripped.slice(0, eq).trimEnd();
    if (!key) continue;
    let val = stripped.slice(eq + 1);
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const commentIdx = val.search(/\s+#/);
      if (commentIdx !== -1) val = val.slice(0, commentIdx);
      val = val.trim();
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load `<dir>/.env` and apply its entries to `process.env` without clobbering
 * variables already set in the real environment.
 * @param dir Directory containing the .env file.
 * @returns The set of variable names that were newly applied (missing file ⇒ empty set).
 * @throws Never - A missing or unreadable .env file yields an empty set.
 */
export async function loadDotEnv(dir: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(path.join(dir, '.env'), 'utf8');
  } catch {
    return new Set();
  }
  const applied = new Set<string>();
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (!(key in process.env)) {
      process.env[key] = value;
      applied.add(key);
    }
  }
  return applied;
}

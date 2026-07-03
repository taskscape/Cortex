import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ExpertConfig, ExpertSource } from "./types.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml"
]);

const MAX_FILE_BYTES = 1_000_000;

export class FileExpertKnowledge {
  private readonly expert: ExpertConfig;

  constructor(expert: ExpertConfig) {
    this.expert = expert;
  }

  async search(query: string, limit: number, signal: AbortSignal): Promise<ExpertSource[]> {
    const files = await listTextFiles(this.expert.roots, signal);
    const terms = tokenize(query);
    const sources: ExpertSource[] = [];

    for (const file of files) {
      signal.throwIfAborted();
      const content = await readFile(file, "utf8");
      const score = scoreContent(content, file, terms);
      if (score <= 0 && terms.length > 0) {
        continue;
      }

      sources.push({
        id: stableId(`${this.expert.id}:${file}`),
        expertId: this.expert.id,
        path: file,
        title: path.basename(file),
        content: trimForContext(content),
        score
      });
    }

    return sources
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
}

async function listTextFiles(roots: string[], signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];

  for (const root of roots) {
    await walk(root, files, signal);
  }

  return files;
}

async function walk(target: string, files: string[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();

  let info;
  try {
    info = await stat(target);
  } catch {
    return;
  }

  if (info.isFile()) {
    if (isTextFile(target) && info.size <= MAX_FILE_BYTES) {
      files.push(target);
    }
    return;
  }

  if (!info.isDirectory()) {
    return;
  }

  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    await walk(path.join(target, entry.name), files, signal);
  }
}

function isTextFile(file: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9_ąćęłńóśźż-]{3,}/gi) ?? []) {
    seen.add(raw);
  }
  return [...seen];
}

function scoreContent(content: string, file: string, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  const haystack = `${file}\n${content}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = haystack.match(new RegExp(`\\b${escaped}\\b`, "g"));
    score += matches?.length ?? 0;
  }

  return score;
}

function trimForContext(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  return normalized.length <= 6_000 ? normalized : `${normalized.slice(0, 6_000)}\n\n[truncated]`;
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

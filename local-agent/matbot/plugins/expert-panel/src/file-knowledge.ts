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
const MANIFEST_TTL_MS = 5_000;
const FILE_READ_CONCURRENCY = 8;

interface ExpertFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

interface CachedExpertFile extends ExpertFileMetadata {
  contextContent: string;
  haystack: string;
}

export class FileExpertKnowledge {
  private readonly expert: ExpertConfig;
  private readonly cache = new Map<string, CachedExpertFile>();
  private manifest: ExpertFileMetadata[] = [];
  private manifestExpiresAt = 0;

  constructor(expert: ExpertConfig) {
    this.expert = expert;
  }

  async search(query: string, limit: number, signal: AbortSignal): Promise<ExpertSource[]> {
    const files = await this.listFiles(signal);
    const terms = tokenize(query);
    const sources = await mapWithConcurrency(files, FILE_READ_CONCURRENCY, async file => {
      signal.throwIfAborted();
      const cached = await this.readCached(file, signal).catch(error => {
        signal.throwIfAborted();
        return undefined;
      });
      if (cached === undefined) return undefined;
      const score = scoreContent(cached.haystack, terms);
      if (score <= 0 && terms.length > 0) {
        return undefined;
      }

      return {
        id: stableId(`${this.expert.id}:${file.path}`),
        expertId: this.expert.id,
        path: file.path,
        title: path.basename(file.path),
        content: cached.contextContent,
        score
      } satisfies ExpertSource;
    });

    return sources
      .filter((source): source is ExpertSource => source !== undefined)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);
  }

  private async listFiles(signal: AbortSignal): Promise<ExpertFileMetadata[]> {
    if (Date.now() < this.manifestExpiresAt) return this.manifest;
    const files = await listTextFiles(this.expert.roots, signal);
    const livePaths = new Set(files.map(file => file.path));
    for (const cachedPath of this.cache.keys()) {
      if (!livePaths.has(cachedPath)) this.cache.delete(cachedPath);
    }
    this.manifest = files;
    this.manifestExpiresAt = Date.now() + MANIFEST_TTL_MS;
    return files;
  }

  private async readCached(file: ExpertFileMetadata, signal: AbortSignal): Promise<CachedExpertFile> {
    const cached = this.cache.get(file.path);
    if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached;
    const content = await readFile(file.path, { encoding: "utf8", signal });
    const next: CachedExpertFile = {
      ...file,
      contextContent: trimForContext(content),
      haystack: `${file.path}\n${content}`.toLowerCase(),
    };
    this.cache.set(file.path, next);
    return next;
  }
}

async function listTextFiles(roots: string[], signal: AbortSignal): Promise<ExpertFileMetadata[]> {
  const files: ExpertFileMetadata[] = [];

  for (const root of roots) {
    await walk(root, files, signal);
  }

  return files;
}

async function walk(target: string, files: ExpertFileMetadata[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();

  let info;
  try {
    info = await stat(target);
  } catch {
    return;
  }

  if (info.isFile()) {
    if (isTextFile(target) && info.size <= MAX_FILE_BYTES) {
      files.push({ path: target, size: info.size, mtimeMs: info.mtimeMs });
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

function scoreContent(haystack: string, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }

  let score = 0;

  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = haystack.match(new RegExp(`\\b${escaped}\\b`, "g"));
    score += matches?.length ?? 0;
  }

  return score;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

function trimForContext(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  return normalized.length <= 6_000 ? normalized : `${normalized.slice(0, 6_000)}\n\n[truncated]`;
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

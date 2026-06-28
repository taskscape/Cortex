import fs from "node:fs/promises";
import path from "node:path";

export interface IndexedChunk {
  id: string;
  path: string;
  canonicalPath: string;
  relativePath?: string;
  projectRoot?: string;
  extension: string;
  fileHash: string;
  modifiedTime: string;
  size: number;
  chunkIndex: number;
  content: string;
}

export interface IndexStore {
  version: 1;
  updatedAt: string;
  chunks: IndexedChunk[];
  skipped: Array<{ path: string; reason: string }>;
}

export function emptyStore(): IndexStore {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    chunks: [],
    skipped: []
  };
}

export async function loadStore(storePath: string): Promise<IndexStore> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as IndexStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyStore();
    }

    throw error;
  }
}

export async function saveStore(storePath: string, store: IndexStore): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify({ ...store, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

import { createHash } from "node:crypto";
import type { KnowledgeEntry } from "./types.js";

export interface EntryInput {
  id?: string;
  sourceType: string;
  sourceUuid?: string;
  content: string;
  summary?: string;
  entities?: string[];
  tags?: string[];
  confidence?: number;
  createdAt?: string;
  updatedAt?: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function makeKnowledgeEntry(input: EntryInput): KnowledgeEntry {
  const contentHash = hashText(input.content);
  const sourceUuid = input.sourceUuid ?? contentHash;
  const id = input.id ?? `${input.sourceType}:${sourceUuid}`;
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id,
    version: contentHash,
    entities: input.entities ?? [],
    tags: input.tags ?? [input.sourceType],
    summary: input.summary ?? summarize(input.content),
    content: input.content,
    contentHash,
    source: {
      type: input.sourceType,
      uuid: sourceUuid
    },
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? input.createdAt ?? now
  };

  if (input.confidence !== undefined) {
    entry.confidence = input.confidence;
  }

  return entry;
}

function summarize(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length <= 240 ? singleLine : `${singleLine.slice(0, 237)}...`;
}

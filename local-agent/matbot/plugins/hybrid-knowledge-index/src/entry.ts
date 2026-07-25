import { createHash } from "node:crypto";
import type { KnowledgeEntry } from "./types.js";

// Every optional here is defaulted by makeKnowledgeEntry, so an explicit `undefined` is a valid way
// to say "absent" — callers extract these from untyped payloads where undefined is the natural miss.
// Spelled `?: T | undefined` rather than `?: T` so those call sites need no conditional spreads.
export interface EntryInput {
  id?: string | undefined;
  sourceType: string;
  sourceUuid?: string | undefined;
  content: string;
  summary?: string | undefined;
  entities?: string[] | undefined;
  tags?: string[] | undefined;
  confidence?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
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

import { createHash } from "node:crypto";
import type { KnowledgeEntry } from "@matatbread/matbot-plugin-api";
// Every optional here is defaulted by makeKnowledgeEntry, so an explicit `undefined` is a valid way
// to say "absent" — callers extract these from untyped payloads where undefined is the natural miss.
// Spelled `?: T | undefined` rather than `?: T` so those call sites need no conditional spreads.
/**
 * Loose input shape for {@link makeKnowledgeEntry}; every optional field may be
 * explicitly `undefined` (callers extract from untyped payloads) and is defaulted.
 */
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
/**
 * SHA-256 hash of text, used as a stable content/source identifier.
 * @param text Text to hash.
 * @returns Full hex digest.
 */
export function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}
/**
 * Build a fully-populated `KnowledgeEntry`, defaulting id/version (content hash),
 * tags, summary, timestamps, and the source uuid from the given input.
 * @param input Partial entry data extracted from an untyped backend payload.
 * @returns A complete knowledge entry with derived defaults filled in.
 */
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

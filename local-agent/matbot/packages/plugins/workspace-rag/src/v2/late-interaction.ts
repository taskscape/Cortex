import type { RagV2RankedHit } from './types.js';
import type { RagV2SearchScope } from './repository.js';

interface ColbertResponse {
  model?: string;
  hits?: Array<Record<string, unknown>>;
}

/**
 * Measurement-gated adapter for a local ColBERT-compatible service. PostgreSQL
 * remains the catalog and authorization authority; every returned document
 * version is re-authorized and every byte range is rehashed before evidence is
 * delivered.
 */
/**
 * Client for the ColBERT late-interaction sidecar used for reranking.
 */
export class RagV2ColbertAdapter {
  readonly url: URL;

  constructor(url: string) {
    this.url = new URL(url);
  }

  /**
   * Reranks candidate passages against the query via the sidecar.
   * @param params - Query text and candidate passages.
   * @returns Passages with late-interaction scores (empty on sidecar failure).
   */
  async search(
    query: string,
    scope: RagV2SearchScope,
    callerSignal?: AbortSignal,
  ): Promise<{ model?: string; hits: RagV2RankedHit[] }> {
    const timeout = AbortSignal.timeout(3_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const response = await fetch(new URL('/search', this.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        workspaceId: scope.workspaceId,
        contextId: scope.contextId,
        generationId: scope.generationId,
        authorizationTokens: scope.authorizationTokens ?? [`workspace:${scope.workspaceId}`],
        documentIds: scope.documentIds ?? [],
        sectionIds: scope.sectionIds ?? [],
        limit: Math.max(1, Math.min(scope.limit, 100)),
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Workspace RAG V2 late-interaction service returned HTTP ${response.status}.`);
    }
    const body = await response.json() as ColbertResponse;
    const values = Array.isArray(body.hits) ? body.hits.slice(0, scope.limit) : [];
    const hits = values.map((value, index): RagV2RankedHit | undefined => {
      const documentVersionId = String(value['documentVersionId'] ?? '');
      const passageId = String(value['passageId'] ?? '');
      const sectionId = String(value['sectionId'] ?? '');
      const contentSha256 = String(value['contentSha256'] ?? '');
      if (!documentVersionId || !passageId || !sectionId || !/^[a-f0-9]{64}$/u.test(contentSha256)) {
        return undefined;
      }
      return {
        level: 'passage',
        id: passageId,
        documentId: String(value['documentId'] ?? ''),
        documentVersionId,
        passageId,
        sectionId,
        path: String(value['path'] ?? ''),
        title: String(value['title'] ?? ''),
        headingPath: Array.isArray(value['headingPath']) ? value['headingPath'].map(String) : [],
        startByte: Number(value['startByte']),
        endByte: Number(value['endByte']),
        startLine: Number(value['startLine']),
        endLine: Number(value['endLine']),
        language: String(value['language'] ?? 'und'),
        text: String(value['text'] ?? ''),
        contentSha256,
        retriever: 'late_interaction',
        retrieverRank: index + 1,
        retrieverScore: Number(value['score'] ?? 0),
        ...(typeof value['sourceId'] === 'string' ? { sourceId: value['sourceId'] } : {}),
        ...(typeof value['sourceVersionId'] === 'string'
          ? { sourceVersionId: value['sourceVersionId'] }
          : {}),
        ...(typeof value['objectPath'] === 'string' ? { objectPath: value['objectPath'] } : {}),
        ...(typeof value['lineIndexPath'] === 'string'
          ? { lineIndexPath: value['lineIndexPath'] }
          : {}),
        retrievalReasons: [`late_interaction rank ${index + 1}`],
      };
    }).filter((value): value is RagV2RankedHit =>
      value !== undefined
      && Number.isSafeInteger(value.startByte)
      && Number.isSafeInteger(value.endByte)
      && value.endByte! > value.startByte!
      && Number.isSafeInteger(value.startLine)
      && Number.isSafeInteger(value.endLine)
      && value.endLine! >= value.startLine!);
    return { ...(body.model ? { model: body.model } : {}), hits };
  }
}


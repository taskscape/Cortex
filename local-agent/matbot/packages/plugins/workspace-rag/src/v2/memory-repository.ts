import { createHash } from 'node:crypto';
import { evaluateRegexMatchesBounded } from './regex-evaluator.js';
import type {
  RagV2CollectionRecord,
  RagV2DocumentRecord,
  RagV2Evidence,
  RagV2Job,
  RagV2JobItem,
  RagV2Level,
  RagV2PassageRecord,
  RagV2PublicationState,
  RagV2RankedHit,
  RagV2RoutingSummaryRecord,
  RagV2SectionRecord,
  RagV2VectorizerInfo,
} from './types.js';
import type {
  RagV2DocumentFingerprint,
  RagV2EmbeddingRecord,
  RagV2GcResult,
  RagV2Publication,
  RagV2Repository,
  RagV2RegexRunRecord,
  RagV2RetrievalRunRecord,
  RagV2SearchScope,
  RagV2StoredRetrievalHit,
} from './repository.js';

/**
 * Computes the cosine similarity of two vectors.
 * @param left - First vector.
 * @param right - Second vector; compared component-wise up to the shorter length.
 * @returns Similarity in [-1, 1], or 0 when either vector has zero norm.
 * @throws Never.
 */
function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

/**
 * Scores lexical overlap between a query and a text.
 *
 * Both sides are lowercased and tokenized into Unicode letter/number runs;
 * matching text tokens are counted and normalized by the geometric mean of
 * the query and text token counts.
 * @param query - Query text.
 * @param text - Candidate text.
 * @returns Overlap score in [0, 1), or 0 when either side has no tokens.
 * @throws Never.
 */
function lexicalScore(query: string, text: string): number {
  const queryTerms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (queryTerms.size === 0 || terms.length === 0) return 0;
  let matches = 0;
  for (const term of terms) if (queryTerms.has(term)) matches++;
  return matches / Math.sqrt(queryTerms.size * terms.length);
}

/**
 * Builds the composite map key for a workspace/context pair.
 * @param workspaceId - Workspace identifier.
 * @param contextId - Context identifier.
 * @returns The two identifiers joined with a NUL separator.
 * @throws Never.
 */
function key(workspaceId: string, contextId: string): string {
  return `${workspaceId}\0${contextId}`;
}

const TERMINAL_JOB_STATES = new Set<RagV2Job['state']>([
  'active_lexical',
  'active_hybrid_partial',
  'active_hybrid_complete',
  'cancelled',
  'retryable_failure',
  'permanent_failure',
  'quarantined',
]);

/**
 * Creates a zeroed garbage-collection result.
 * @param deletionsSkipped - True when collection was skipped, typically because ingestion is in flight.
 * @returns A {@link RagV2GcResult} with all deletion counters at zero.
 * @throws Never.
 */
function emptyGcResult(deletionsSkipped = false): RagV2GcResult {
  return {
    documentsDeleted: 0,
    passagesDeleted: 0,
    sectionsDeleted: 0,
    embeddingsDeleted: 0,
    collectionsDeleted: 0,
    routingSummariesDeleted: 0,
    blobsDeleted: 0,
    deletionsSkipped,
  };
}

/**
 * In-memory {@link RagV2Repository} used when no Postgres backend is
 * configured. All state lives for the process lifetime only.
 */
export class MemoryRagV2Repository implements RagV2Repository {
  readonly backend = 'memory' as const;
  private readonly publications = new Map<string, RagV2Publication[]>();
  private readonly jobs = new Map<string, RagV2Job>();
  private readonly jobItems = new Map<string, RagV2JobItem>();
  private readonly documents = new Map<string, RagV2DocumentRecord>();
  private readonly collections = new Map<string, RagV2CollectionRecord>();
  private readonly routingSummaries = new Map<string, RagV2RoutingSummaryRecord>();
  private readonly generationDocuments = new Map<string, Map<string, string>>();
  private readonly sections = new Map<string, RagV2SectionRecord>();
  private readonly passages = new Map<string, RagV2PassageRecord>();
  private readonly embeddings = new Map<string, RagV2EmbeddingRecord>();
  private readonly runs = new Map<string, RagV2RetrievalRunRecord>();
  readonly storedHits: RagV2StoredRetrievalHit[] = [];
  readonly storedEvidence: Array<{ runId: string; evidence: RagV2Evidence }> = [];
  readonly evaluationRuns: unknown[] = [];
  readonly regexRuns: RagV2RegexRunRecord[] = [];
  private vectorizer: RagV2VectorizerInfo | undefined;

  /**
   * Prepares the repository and records the active vectorizer signature.
   * @param vectorizer - Active vectorizer descriptor; cloned, so later caller mutations have no effect.
   * @returns Resolves once the signature is recorded.
   * @throws Never.
   */
  async initialize(vectorizer: RagV2VectorizerInfo): Promise<void> {
    this.vectorizer = structuredClone(vectorizer);
  }

  /**
   * Releases resources; the in-memory backend holds none.
   * @returns Resolves immediately.
   * @throws Never.
   */
  async close(): Promise<void> {}

  /**
   * Stages a new generation for a context, idempotently.
   *
   * The new publication starts in the `staging` state with the recorded
   * vectorizer signature. Its document set is seeded from
   * `sourceGenerationId` when given, otherwise from the currently active
   * publication, otherwise left empty.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation to stage; an already known generation is left untouched.
   * @param sourceGenerationId - Optional generation whose document membership is copied; defaults to the active publication.
   * @returns Resolves once the publication is staged.
   * @throws Never.
   */
  async beginGeneration(workspaceId: string, contextId: string, generationId: string, sourceGenerationId?: string): Promise<void> {
    const publicationKey = key(workspaceId, contextId);
    const values = this.publications.get(publicationKey) ?? [];
    if (values.some(value => value.generationId === generationId)) return;
    values.push({
      generationId,
      workspaceId,
      contextId,
      state: 'staging',
      embeddingSignature: this.vectorizer?.signature ?? 'uninitialized',
      active: false,
      createdAt: new Date().toISOString(),
    });
    this.publications.set(publicationKey, values);
    const active = values.find(value => sourceGenerationId ? value.generationId === sourceGenerationId : value.active);
    this.generationDocuments.set(
      generationId,
      active ? new Map(this.generationDocuments.get(active.generationId) ?? []) : new Map(),
    );
  }

  /**
   * Returns the currently active publication of a context.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @returns The active publication, or undefined when nothing is published.
   * @throws Never.
   */
  async activePublication(workspaceId: string, contextId: string): Promise<RagV2Publication | undefined> {
    return this.publications.get(key(workspaceId, contextId))?.find(value => value.active);
  }

  /**
   * Looks up one publication by generation identifier.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation to find.
   * @returns The matching publication, or undefined when unknown.
   * @throws Never.
   */
  async generation(
    workspaceId: string,
    contextId: string,
    generationId: string,
  ): Promise<RagV2Publication | undefined> {
    return this.publications.get(key(workspaceId, contextId))
      ?.find(value => value.generationId === generationId);
  }

  /**
   * Deletes stale staging publications of a context.
   *
   * Removes every non-active publication still in the `staging` state except
   * the one to keep, dropping each one's generation-to-documents mapping.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param keepGenerationId - Generation whose staging record must survive.
   * @returns Number of publications pruned.
   * @throws Never.
   */
  async pruneStagingGenerations(
    workspaceId: string,
    contextId: string,
    keepGenerationId: string,
  ): Promise<number> {
    const publicationKey = key(workspaceId, contextId);
    const values = this.publications.get(publicationKey) ?? [];
    const stale = values.filter(value =>
      !value.active && value.state === 'staging' && value.generationId !== keepGenerationId);
    for (const publication of stale) this.generationDocuments.delete(publication.generationId);
    this.publications.set(
      publicationKey,
      values.filter(value => !stale.includes(value)),
    );
    return stale.length;
  }

  /**
   * Garbage-collects records of a context unreachable from live generations.
   *
   * Skips all deletion (reporting `deletionsSkipped`) while a non-terminal
   * job is in flight. Otherwise removes documents last modified before the
   * cutoff that no live (staging or active) generation references, together
   * with their sections, passages, and non-collection embeddings; routing
   * summaries of unknown documents or dead generations; collection-level
   * embeddings without a live collection; and a terminal job older than the
   * cutoff together with its job items.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param olderThan - ISO-8601 cutoff; records modified at or after it are kept.
   * @returns Deletion counters for this run.
   * @throws Never.
   */
  async pruneOrphans(
    workspaceId: string,
    contextId: string,
    olderThan: string,
  ): Promise<RagV2GcResult> {
    const current = this.jobs.get(key(workspaceId, contextId));
    if (current && !TERMINAL_JOB_STATES.has(current.state)) return emptyGcResult(true);

    const cutoff = Date.parse(olderThan);
    const liveGenerations = new Set(
      (this.publications.get(key(workspaceId, contextId)) ?? [])
        .filter(publication => publication.state === 'staging' || publication.state.startsWith('active_'))
        .map(publication => publication.generationId),
    );
    const liveVersions = new Set<string>();
    for (const generationId of liveGenerations) {
      for (const documentVersionId of this.generationDocuments.get(generationId)?.values() ?? []) {
        liveVersions.add(documentVersionId);
      }
    }
    const doomed = new Set(
      [...this.documents.values()]
        .filter(document => document.workspaceId === workspaceId
          && document.contextId === contextId
          && Date.parse(document.modifiedAt) < cutoff
          && !liveVersions.has(document.documentVersionId))
        .map(document => document.documentVersionId),
    );
    const result = emptyGcResult();
    result.documentsDeleted = doomed.size;
    result.sectionsDeleted = [...this.sections.values()]
      .filter(section => doomed.has(section.documentVersionId)).length;
    result.passagesDeleted = [...this.passages.values()]
      .filter(passage => doomed.has(passage.documentVersionId)).length;

    for (const publication of this.publications.get(key(workspaceId, contextId)) ?? []) {
      if (liveGenerations.has(publication.generationId)) continue;
      const membership = this.generationDocuments.get(publication.generationId);
      if (!membership) continue;
      for (const [documentId, documentVersionId] of membership) {
        if (doomed.has(documentVersionId)) membership.delete(documentId);
      }
    }

    for (const [embeddingKey, embedding] of this.embeddings) {
      if (embedding.workspaceId !== workspaceId || embedding.contextId !== contextId) continue;
      if (embedding.level !== 'collection' && doomed.has(embedding.documentVersionId)) {
        this.embeddings.delete(embeddingKey);
        result.embeddingsDeleted++;
      }
    }
    for (const [sectionId, section] of this.sections) {
      if (doomed.has(section.documentVersionId)) this.sections.delete(sectionId);
    }
    for (const [passageId, passage] of this.passages) {
      if (doomed.has(passage.documentVersionId)) this.passages.delete(passageId);
    }
    for (const documentVersionId of doomed) this.documents.delete(documentVersionId);

    for (const [summaryId, summary] of this.routingSummaries) {
      if (summary.workspaceId !== workspaceId || summary.contextId !== contextId) continue;
      if ((summary.documentVersionId && !this.documents.has(summary.documentVersionId))
        || !liveGenerations.has(summary.generationId)) {
        this.routingSummaries.delete(summaryId);
        result.routingSummariesDeleted++;
      }
    }
    const liveCollections = new Set(
      [...this.collections.values()]
        .filter(collection => collection.workspaceId === workspaceId && collection.contextId === contextId)
        .map(collection => collection.collectionVersionId),
    );
    for (const [embeddingKey, embedding] of this.embeddings) {
      if (embedding.workspaceId === workspaceId && embedding.contextId === contextId
        && embedding.level === 'collection' && !liveCollections.has(embedding.unitId)) {
        this.embeddings.delete(embeddingKey);
        result.embeddingsDeleted++;
      }
    }

    if (current && TERMINAL_JOB_STATES.has(current.state) && Date.parse(current.updatedAt) < cutoff) {
      this.jobs.delete(key(workspaceId, contextId));
      for (const [itemKey, item] of this.jobItems) {
        if (item.jobId === current.id) this.jobItems.delete(itemKey);
      }
    }
    return result;
  }

  /**
   * Deletes retired generations published before a cutoff.
   *
   * Removes each matching publication together with its collections, their
   * collection-level embeddings, and its generation-to-documents mapping.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param olderThan - ISO-8601 cutoff applied to `publishedAt`; publications without one are kept.
   * @returns Number of retired generations removed.
   * @throws Never.
   */
  async pruneRetiredGenerations(
    workspaceId: string,
    contextId: string,
    olderThan: string,
  ): Promise<number> {
    const cutoff = Date.parse(olderThan);
    const publicationKey = key(workspaceId, contextId);
    const values = this.publications.get(publicationKey) ?? [];
    const retired = values.filter(publication => publication.state === 'retired'
      && publication.publishedAt !== undefined
      && Date.parse(publication.publishedAt) < cutoff);
    const generationIds = new Set(retired.map(publication => publication.generationId));
    const removedCollections = new Set<string>();
    for (const [collectionVersionId, collection] of this.collections) {
      if (generationIds.has(collection.generationId)) {
        removedCollections.add(collectionVersionId);
        this.collections.delete(collectionVersionId);
      }
    }
    for (const [embeddingKey, embedding] of this.embeddings) {
      if (embedding.level === 'collection' && removedCollections.has(embedding.unitId)) {
        this.embeddings.delete(embeddingKey);
      }
    }
    for (const generationId of generationIds) this.generationDocuments.delete(generationId);
    this.publications.set(publicationKey, values.filter(publication => !generationIds.has(publication.generationId)));
    return generationIds.size;
  }

  /**
   * Removes every v2 record of a context: publications, generation mappings,
   * collections, documents, sections, passages, embeddings, routing
   * summaries, the job, and its job items.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @returns Resolves once the context is empty.
   * @throws Error - When a non-terminal ingestion job is in flight for the context.
   */
  async purgeContext(workspaceId: string, contextId: string): Promise<void> {
    const current = this.jobs.get(key(workspaceId, contextId));
    if (current && !TERMINAL_JOB_STATES.has(current.state)) {
      throw new Error(`Workspace RAG V2 cannot purge ${workspaceId}/${contextId} while ingestion is ${current.state}.`);
    }
    const publicationKey = key(workspaceId, contextId);
    const generationIds = new Set(
      (this.publications.get(publicationKey) ?? []).map(publication => publication.generationId),
    );
    const documentVersionIds = new Set(
      [...this.documents.values()]
        .filter(document => document.workspaceId === workspaceId && document.contextId === contextId)
        .map(document => document.documentVersionId),
    );
    for (const generationId of generationIds) this.generationDocuments.delete(generationId);
    this.publications.delete(publicationKey);
    for (const [collectionVersionId, collection] of this.collections) {
      if (collection.workspaceId === workspaceId && collection.contextId === contextId) {
        this.collections.delete(collectionVersionId);
      }
    }
    for (const documentVersionId of documentVersionIds) this.documents.delete(documentVersionId);
    for (const [sectionId, section] of this.sections) {
      if (section.workspaceId === workspaceId && section.contextId === contextId) this.sections.delete(sectionId);
    }
    for (const [passageId, passage] of this.passages) {
      if (passage.workspaceId === workspaceId && passage.contextId === contextId) this.passages.delete(passageId);
    }
    for (const [embeddingKey, embedding] of this.embeddings) {
      if (embedding.workspaceId === workspaceId && embedding.contextId === contextId) this.embeddings.delete(embeddingKey);
    }
    for (const [summaryId, summary] of this.routingSummaries) {
      if (summary.workspaceId === workspaceId && summary.contextId === contextId) this.routingSummaries.delete(summaryId);
    }
    this.jobs.delete(publicationKey);
    for (const [itemKey, item] of this.jobItems) {
      if (item.workspaceId === workspaceId && item.contextId === contextId) this.jobItems.delete(itemKey);
    }
  }

  /**
   * Collects the content hashes of every stored document version.
   * @returns Hashes across all workspaces and contexts, for use by blob GC.
   * @throws Never.
   */
  async listReferencedContentHashes(): Promise<Set<string>> {
    return new Set([...this.documents.values()].map(document => document.contentSha256));
  }

  /**
   * Activates a staged generation and retires the previous one.
   *
   * Any currently active publication becomes inactive and moves to the
   * `retired` state; the target generation becomes active with `state` and a
   * fresh `publishedAt`. Member documents of the generation get their
   * publication state updated to match.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation to activate.
   * @param state - Active state to publish as (lexical, hybrid partial, or hybrid complete).
   * @returns Resolves once the switch is applied.
   * @throws Never.
   */
  async publishGeneration(
    workspaceId: string,
    contextId: string,
    generationId: string,
    state: Extract<RagV2PublicationState, 'active_lexical' | 'active_hybrid_partial' | 'active_hybrid_complete'>,
  ): Promise<void> {
    const values = this.publications.get(key(workspaceId, contextId)) ?? [];
    for (const publication of values) {
      if (publication.active) {
        publication.active = false;
        publication.state = 'retired';
      }
      if (publication.generationId === generationId) {
        publication.active = true;
        publication.state = state;
        publication.publishedAt = new Date().toISOString();
      }
    }
    for (const documentVersionId of this.generationDocuments.get(generationId)?.values() ?? []) {
      const document = this.documents.get(documentVersionId);
      if (document) document.publicationState = state;
    }
  }

  /**
   * Summarizes the structural health of one generation.
   * @param _workspaceId - Accepted for interface parity; unused.
   * @param _contextId - Accepted for interface parity; unused.
   * @param generationId - Generation whose documents, sections, and passages are inspected.
   * @returns Counters for the generation, a `valid` flag (false only when a stored passage has a non-increasing byte or line range), and an always-empty error list.
   * @throws Never.
   */
  async validateGeneration(_workspaceId: string, _contextId: string, generationId: string) {
    const versionIds = new Set(this.generationDocuments.get(generationId)?.values() ?? []);
    const sections = [...this.sections.values()].filter(value => versionIds.has(value.documentVersionId));
    const passages = [...this.passages.values()].filter(value => versionIds.has(value.documentVersionId));
    return {
      valid: versionIds.size === 0 || passages.every(value => value.endByte > value.startByte && value.endLine >= value.startLine),
      documents: versionIds.size,
      sections: sections.length,
      passages: passages.length,
      lexicalReady: passages.filter(value => value.lexicalState === 'ready').length,
      passageEmbeddings: passages.filter(value =>
        this.embeddings.has(
          `${this.vectorizer?.signature ?? ''}\0passage\0${value.passageId}`,
        )).length,
      errors: [],
    };
  }

  /**
   * Records the job for a context, replacing any previous one.
   * @param job - Job to store; cloned, so later caller mutations have no effect.
   * @returns Resolves once the job is stored.
   * @throws Never.
   */
  async createJob(job: RagV2Job): Promise<void> {
    this.jobs.set(key(job.workspaceId, job.contextId), structuredClone(job));
  }

  /**
   * Overwrites the stored job for the job's context.
   * @param job - Job to store; cloned, so later caller mutations have no effect.
   * @returns Resolves once the job is stored.
   * @throws Never.
   */
  async updateJob(job: RagV2Job): Promise<void> {
    this.jobs.set(key(job.workspaceId, job.contextId), structuredClone(job));
  }

  /**
   * Returns the job currently recorded for a context.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @returns A clone of the job, or undefined when none is recorded.
   * @throws Never.
   */
  async currentJob(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const job = this.jobs.get(key(workspaceId, contextId));
    return job ? structuredClone(job) : undefined;
  }

  /**
   * Inserts or replaces one per-file progress entry.
   * @param item - Item to store, keyed by job id and path; cloned.
   * @returns Resolves once the item is stored.
   * @throws Never.
   */
  async upsertJobItem(item: RagV2JobItem): Promise<void> {
    this.jobItems.set(`${item.jobId}\0${item.path}`, structuredClone(item));
  }

  /**
   * Counts document versions recorded for a generation.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation to count; defaults to the active publication's generation.
   * @returns Number of documents in the generation, or 0 when it is unknown.
   * @throws Never.
   */
  async countGenerationDocuments(workspaceId: string, contextId: string, generationId?: string): Promise<number> {
    const generation = generationId ?? (await this.activePublication(workspaceId, contextId))?.generationId;
    return generation ? this.generationDocuments.get(generation)?.size ?? 0 : 0;
  }

  /**
   * Lists change-detection fingerprints for a generation's documents.
   *
   * A `summarySignature` is included only when a document-level summary
   * exists and the document's sections either have no section-level
   * summaries or all share that same summarizer signature.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation to fingerprint; defaults to the active publication.
   * @returns One fingerprint per document version in the generation; empty when the generation is unknown.
   * @throws Never.
   */
  async listFingerprints(
    workspaceId: string,
    contextId: string,
    generationId?: string,
  ): Promise<RagV2DocumentFingerprint[]> {
    const active = generationId
      ? await this.generation(workspaceId, contextId, generationId)
      : await this.activePublication(workspaceId, contextId);
    if (!active) return [];
    const versions = new Set(this.generationDocuments.get(active.generationId)?.values() ?? []);
    const documentSummarySignatures = new Map<string, string>();
    const sectionSummarySignatures = new Map<string, string>();
    for (const summary of this.routingSummaries.values()) {
      if (summary.workspaceId !== workspaceId || summary.contextId !== contextId) continue;
      if (summary.level === 'document') documentSummarySignatures.set(summary.unitId, summary.summarizerSignature);
      if (summary.level === 'section') sectionSummarySignatures.set(summary.unitId, summary.summarizerSignature);
    }
    const sectionSignaturesByDocument = new Map<string, Set<string>>();
    for (const section of this.sections.values()) {
      if (!versions.has(section.documentVersionId)) continue;
      const signatures = sectionSignaturesByDocument.get(section.documentVersionId) ?? new Set<string>();
      signatures.add(sectionSummarySignatures.get(section.sectionId) ?? '');
      sectionSignaturesByDocument.set(section.documentVersionId, signatures);
    }
    return [...this.documents.values()]
      .filter(document => versions.has(document.documentVersionId))
      .map(document => ({
        documentId: document.documentId,
        documentVersionId: document.documentVersionId,
        path: document.path,
        byteLength: document.byteLength,
        modifiedAt: document.modifiedAt,
        contentSha256: document.contentSha256,
        embeddingSignature: active.embeddingSignature,
        ...(documentSummarySignatures.get(document.documentVersionId)
          && (
            !sectionSignaturesByDocument.has(document.documentVersionId)
            || (
              sectionSignaturesByDocument.get(document.documentVersionId)?.size === 1
              && sectionSignaturesByDocument.get(document.documentVersionId)?.has(documentSummarySignatures.get(document.documentVersionId)!)
            )
          )
          ? { summarySignature: documentSummarySignatures.get(document.documentVersionId)! }
          : {}),
      }));
  }

  /**
   * Stores or overwrites a document record before its content is indexed.
   *
   * Generation membership is only recorded later, by
   * {@link MemoryRagV2Repository.finishDocument}.
   * @param _generationId - Accepted for interface parity; unused at this stage.
   * @param document - Record to store; cloned.
   * @returns Resolves once the record is stored.
   * @throws Never.
   */
  async beginDocument(_generationId: string, document: RagV2DocumentRecord): Promise<void> {
    this.documents.set(document.documentVersionId, structuredClone(document));
  }

  /**
   * Inserts or replaces the given section records.
   * @param sections - Sections to store; each is cloned.
   * @returns Resolves once all sections are stored.
   * @throws Never.
   */
  async appendSections(sections: readonly RagV2SectionRecord[]): Promise<void> {
    for (const section of sections) this.sections.set(section.sectionId, structuredClone(section));
  }

  /**
   * Inserts or replaces the given passage records.
   * @param passages - Passages to store; each is cloned.
   * @returns Resolves once all passages are stored.
   * @throws Never.
   */
  async appendPassages(passages: readonly RagV2PassageRecord[]): Promise<void> {
    for (const passage of passages) this.passages.set(passage.passageId, structuredClone(passage));
  }

  /**
   * Stores embedding vectors and marks their target units ready.
   *
   * Records are keyed by vectorizer signature, level, and unit id. The
   * collection, section, or passage named by `unitId` gets its embedding
   * state set to `ready`; the document level marks the record's document.
   * @param records - Embedding records to store; each is cloned.
   * @param _vectorizer - Accepted for interface parity; unused (the signature inside each record selects the key).
   * @returns Resolves once all records are stored.
   * @throws Never.
   */
  async putEmbeddings(records: readonly RagV2EmbeddingRecord[], _vectorizer: RagV2VectorizerInfo): Promise<void> {
    for (const record of records) {
      this.embeddings.set(`${record.signature}\0${record.level}\0${record.unitId}`, structuredClone(record));
      if (record.level === 'collection') {
        const collection = this.collections.get(record.unitId);
        if (collection) collection.embeddingState = 'ready';
      } else if (record.level === 'passage') {
        const passage = this.passages.get(record.unitId);
        if (passage) passage.embeddingState = 'ready';
      } else if (record.level === 'section') {
        const section = this.sections.get(record.unitId);
        if (section) section.embeddingState = 'ready';
      } else {
        const document = this.documents.get(record.documentVersionId);
        if (document) document.embeddingState = 'ready';
      }
    }
  }

  /**
   * Copies existing vectors instead of recomputing them where possible.
   *
   * A record is reused when a stored embedding matches its vectorizer
   * signature, level, and input hash; the stored vector is then written for
   * the new unit, which also marks that unit ready.
   * @param records - Vector-less embedding records describing the units to fill.
   * @param _vectorizer - Accepted for interface parity; unused.
   * @returns Unit ids whose embeddings were reused.
   * @throws Never.
   */
  async reuseEmbeddings(
    records: readonly Omit<RagV2EmbeddingRecord, 'vector'>[],
    _vectorizer: RagV2VectorizerInfo,
  ): Promise<Set<string>> {
    const reused = new Set<string>();
    for (const record of records) {
      const existing = [...this.embeddings.values()].find(value =>
        value.signature === record.signature
        && value.level === record.level
        && value.inputSha256 === record.inputSha256);
      if (!existing) continue;
      await this.putEmbeddings([{ ...record, vector: existing.vector }], _vectorizer);
      reused.add(record.unitId);
    }
    return reused;
  }

  /**
   * Cold-evicts passage embeddings of a generation, oldest first.
   *
   * Ready passages of the generation are visited in ordinal order and the
   * first `limit` have their vectors deleted and their state set to
   * `evicted`.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation whose passages are eligible.
   * @param limit - Maximum number of passages to evict.
   * @param vectorizer - Active vectorizer; its signature keys the deleted embeddings.
   * @returns Number of passages evicted.
   * @throws Never.
   */
  async evictPassageEmbeddings(
    workspaceId: string,
    contextId: string,
    generationId: string,
    limit: number,
    vectorizer: RagV2VectorizerInfo,
  ): Promise<number> {
    const versions = new Set(this.generationDocuments.get(generationId)?.values() ?? []);
    const candidates = [...this.passages.values()]
      .filter(passage =>
        passage.workspaceId === workspaceId
        && passage.contextId === contextId
        && versions.has(passage.documentVersionId)
        && passage.embeddingState === 'ready')
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(0, limit);
    for (const passage of candidates) {
      this.embeddings.delete(`${vectorizer.signature}\0passage\0${passage.passageId}`);
      passage.embeddingState = 'evicted';
    }
    return candidates.length;
  }

  /**
   * Stores the completed document record and adds it to its generation.
   * @param generationId - Generation the document belongs to; ignored when the generation is unknown.
   * @param document - Final record to store; cloned.
   * @returns Resolves once the record and membership are stored.
   * @throws Never.
   */
  async finishDocument(generationId: string, document: RagV2DocumentRecord): Promise<void> {
    this.documents.set(document.documentVersionId, structuredClone(document));
    this.generationDocuments.get(generationId)?.set(document.documentId, document.documentVersionId);
  }

  /**
   * Rebuilds collection records for a generation from its documents.
   *
   * Existing collections of the generation are deleted first. Documents
   * carrying a `collectionId` are grouped; each collection gets a content
   * hash over its members' sorted hashes and a version hash over generation,
   * collection id, and content hash. Its routing summary concatenates the
   * first 50 member summaries and is truncated to 12,000 characters.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation whose collections are rebuilt.
   * @returns The newly created collection records, in grouping order.
   * @throws Never.
   */
  async rebuildCollections(
    workspaceId: string,
    contextId: string,
    generationId: string,
  ): Promise<RagV2CollectionRecord[]> {
    for (const [key, collection] of this.collections) {
      if (collection.generationId === generationId) this.collections.delete(key);
    }
    const versions = new Set(this.generationDocuments.get(generationId)?.values() ?? []);
    const grouped = new Map<string, RagV2DocumentRecord[]>();
    for (const document of this.documents.values()) {
      if (!versions.has(document.documentVersionId) || !document.collectionId) continue;
      const values = grouped.get(document.collectionId) ?? [];
      values.push(document);
      grouped.set(document.collectionId, values);
    }
    const result: RagV2CollectionRecord[] = [];
    for (const [collectionId, documents] of grouped) {
      const contentSha256 = createHash('sha256')
        .update(documents.map(value => value.contentSha256).sort().join('\0'))
        .digest('hex');
      const collectionVersionId = createHash('sha256')
        .update(`${generationId}\0${collectionId}\0${contentSha256}`)
        .digest('hex');
      const record: RagV2CollectionRecord = {
        collectionId,
        collectionVersionId,
        generationId,
        workspaceId,
        contextId,
        title: documents.find(value => value.collectionTitle)?.collectionTitle ?? collectionId,
        documentCount: documents.length,
        contentSha256,
        routingSummary: documents.slice(0, 50).map(value => `${value.title}: ${value.routingSummary}`).join('\n').slice(0, 12_000),
        embeddingState: 'queued',
        createdAt: new Date().toISOString(),
      };
      this.collections.set(collectionVersionId, structuredClone(record));
      result.push(record);
    }
    return result;
  }

  /**
   * Looks up a routing summary by source content and summarizer signature.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param level - Summary level to match.
   * @param sourceContentSha256 - Content hash the summary was generated from.
   * @param summarizerSignature - Signature of the summarizer that produced it.
   * @returns A clone of the matching record, or undefined when absent.
   * @throws Never.
   */
  async findRoutingSummary(
    workspaceId: string,
    contextId: string,
    level: RagV2RoutingSummaryRecord['level'],
    sourceContentSha256: string,
    summarizerSignature: string,
  ): Promise<RagV2RoutingSummaryRecord | undefined> {
    const found = [...this.routingSummaries.values()].find(value =>
      value.workspaceId === workspaceId
      && value.contextId === contextId
      && value.level === level
      && value.sourceContentSha256 === sourceContentSha256
      && value.summarizerSignature === summarizerSignature);
    return found ? structuredClone(found) : undefined;
  }

  /**
   * Stores a routing summary and mirrors its text onto the unit.
   *
   * The collection, document, or section identified by `unitId` (per
   * `level`) gets its `routingSummary` replaced with the summary text.
   * @param summary - Record to store; cloned.
   * @returns Resolves once the summary is stored.
   * @throws Never.
   */
  async putRoutingSummary(summary: RagV2RoutingSummaryRecord): Promise<void> {
    this.routingSummaries.set(summary.summaryId, structuredClone(summary));
    if (summary.level === 'collection') {
      const collection = this.collections.get(summary.unitId);
      if (collection) collection.routingSummary = summary.summary;
    } else if (summary.level === 'document') {
      const document = this.documents.get(summary.unitId);
      if (document) document.routingSummary = summary.summary;
    } else {
      const section = this.sections.get(summary.unitId);
      if (section) section.routingSummary = summary.summary;
    }
  }

  /**
   * Drops generation membership for paths no longer present in a job.
   * @param jobId - Job whose item paths define the retained set.
   * @param _workspaceId - Accepted for interface parity; unused.
   * @param _contextId - Accepted for interface parity; unused.
   * @param generationId - Generation whose document mapping is reconciled; unknown generations are ignored.
   * @returns Number of document versions removed from the generation.
   * @throws Never.
   */
  async reconcileGeneration(
    jobId: string,
    _workspaceId: string,
    _contextId: string,
    generationId: string,
  ): Promise<number> {
    const seen = new Set(
      [...this.jobItems.values()].filter(item => item.jobId === jobId).map(item => item.path),
    );
    const mapping = this.generationDocuments.get(generationId);
    if (!mapping) return 0;
    let removed = 0;
    for (const [documentId, documentVersionId] of mapping) {
      const document = this.documents.get(documentVersionId);
      if (document && !seen.has(document.path)) {
        mapping.delete(documentId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Ranks candidate records by lexical overlap with the query.
   * @param level - Granularity to search.
   * @param query - Free-text query.
   * @param scope - Authorization, filtering, and limit constraints.
   * @returns Hits from the lexical retriever for `level`, ordered by descending {@link lexicalScore}, truncated to `scope.limit`; zero-score records are excluded.
   * @throws Never.
   */
  async lexicalSearch(level: RagV2Level, query: string, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    return this.searchRecords(level, scope)
      .map(record => ({ record, score: lexicalScore(query, record.searchText ?? record.text) }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, scope.limit)
      .map(({ record, score }, index) => this.toHit(record, `${level}_lexical`, index + 1, score));
  }

  /**
   * Finds passages containing the given literal references.
   *
   * Matching is case-insensitive substring counting against passage text.
   * @param references - Literal strings to look for; empty input returns no hits.
   * @param scope - Authorization, filtering, and limit constraints.
   * @returns Hits with retriever `exact_reference`, ordered by descending match count, truncated to `scope.limit`.
   * @throws Never.
   */
  async exactSearch(references: readonly string[], scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    const normalized = references.map(value => value.toLocaleLowerCase()).filter(Boolean);
    if (normalized.length === 0) return [];
    return this.searchRecords('passage', scope)
      .map(record => ({ record, score: normalized.reduce((sum, value) => sum + (record.text.toLocaleLowerCase().includes(value) ? 1 : 0), 0) }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, scope.limit)
      .map(({ record, score }, index) => this.toHit(record, 'exact_reference', index + 1, score));
  }

  /**
   * Ranks candidate records by cosine similarity to a query vector.
   * @param level - Granularity to search.
   * @param queryVector - Query embedding to compare against.
   * @param vectorizer - Vectorizer whose signature selects the embeddings.
   * @param scope - Authorization, filtering, and limit constraints.
   * @returns Hits from the dense retriever for `level`, ordered by descending similarity, truncated to `scope.limit`; records without a stored embedding for `vectorizer` score 0 and are excluded.
   * @throws Never.
   */
  async denseSearch(
    level: RagV2Level,
    queryVector: readonly number[],
    vectorizer: RagV2VectorizerInfo,
    scope: RagV2SearchScope,
  ): Promise<RagV2RankedHit[]> {
    return this.searchRecords(level, scope)
      .map(record => ({
        record,
        score: cosine(
          queryVector,
          this.embeddings.get(`${vectorizer.signature}\0${level}\0${record.id}`)?.vector ?? [],
        ),
      }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, scope.limit)
      .map(({ record, score }, index) => this.toHit(record, `${level}_dense`, index + 1, score));
  }

  /**
   * Lists passages of one section within a generation.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation whose documents bound the search.
   * @param sectionId - Section whose passages are returned.
   * @param onlyMissingEmbeddings - When true, passages already in the `ready` embedding state are excluded.
   * @returns Cloned passages ordered by ordinal.
   * @throws Never.
   */
  async passagesForSection(
    workspaceId: string,
    contextId: string,
    generationId: string,
    sectionId: string,
    onlyMissingEmbeddings: boolean,
  ): Promise<RagV2PassageRecord[]> {
    const versions = new Set(this.generationDocuments.get(generationId)?.values() ?? []);
    return [...this.passages.values()]
      .filter(passage =>
        passage.workspaceId === workspaceId
        && passage.contextId === contextId
        && passage.sectionId === sectionId
        && versions.has(passage.documentVersionId)
        && (!onlyMissingEmbeddings || passage.embeddingState !== 'ready'))
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(value => structuredClone(value));
  }

  /**
   * Fetches one document version after checking workspace, context, and ACL.
   * @param workspaceId - Expected owning workspace.
   * @param contextId - Expected indexed context.
   * @param documentVersionId - Version to fetch.
   * @param authorizationTokens - Caller tokens; at least one must match the document's ACL tokens.
   * @returns A clone of the record, or undefined when absent, foreign, or unauthorized.
   * @throws Never.
   */
  async documentVersion(
    workspaceId: string,
    contextId: string,
    documentVersionId: string,
    authorizationTokens: readonly string[],
  ): Promise<RagV2DocumentRecord | undefined> {
    const document = this.documents.get(documentVersionId);
    if (!document || document.workspaceId !== workspaceId || document.contextId !== contextId
      || !document.aclTokens.some(token => authorizationTokens.includes(token))) return undefined;
    return structuredClone(document);
  }

  /**
   * Narrows passages of specific document versions by a regex.
   *
   * Candidates come from the passage-level search path restricted to the
   * given versions; evaluation runs in a bounded worker via
   * {@link evaluateRegexMatchesBounded}, so the pattern should already be
   * validated with {@link assertSafeRegex}.
   * @param workspaceId - Owning workspace.
   * @param contextId - Indexed context within the workspace.
   * @param generationId - Generation whose documents bound the search.
   * @param documentVersionIds - Versions whose passages may match.
   * @param pattern - Validated regular expression, evaluated case-insensitively.
   * @param authorizationTokens - Caller tokens for ACL filtering.
   * @param limit - Maximum number of hits returned.
   * @returns Matching hits with retriever `narrowed_regex` and uniform score 1, truncated to `limit`.
   * @throws Error - When regex evaluation exceeds its time budget or the evaluator worker fails.
   */
  async grepDocuments(
    workspaceId: string,
    contextId: string,
    generationId: string,
    documentVersionIds: readonly string[],
    pattern: string,
    authorizationTokens: readonly string[],
    limit: number,
  ): Promise<RagV2RankedHit[]> {
    const candidates = this.searchRecords('passage', {
      workspaceId,
      contextId,
      generationId,
      authorizationTokens: [...authorizationTokens],
      documentIds: [...this.documents.values()]
        .filter(document => documentVersionIds.includes(document.documentVersionId))
        .map(document => document.documentId),
      limit,
    });
    const matched = await evaluateRegexMatchesBounded(pattern, candidates.map(record => record.text));
    return candidates
      .filter((_record, index) => matched.has(index))
      .slice(0, limit)
      .map((record, index) => this.toHit(record, 'narrowed_regex', index + 1, 1));
  }

  /**
   * Records a retrieval run, replacing any previous record with the same id.
   * @param run - Run record to store; cloned.
   * @returns Resolves once the run is stored.
   * @throws Never.
   */
  async createRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  /**
   * Appends retrieval hits to the in-memory audit trail.
   * @param _workspaceId - Accepted for interface parity; unused.
   * @param _contextId - Accepted for interface parity; unused.
   * @param hits - Hits to append; cloned.
   * @returns Resolves once the hits are appended.
   * @throws Never.
   */
  async appendRetrievalHits(
    _workspaceId: string,
    _contextId: string,
    hits: readonly RagV2StoredRetrievalHit[],
  ): Promise<void> {
    this.storedHits.push(...structuredClone(hits));
  }

  /**
   * Appends citation evidence to the in-memory audit trail, tagged with its run.
   * @param _workspaceId - Accepted for interface parity; unused.
   * @param _contextId - Accepted for interface parity; unused.
   * @param runId - Retrieval run the evidence belongs to.
   * @param evidence - Evidence items to append; cloned.
   * @returns Resolves once the evidence is appended.
   * @throws Never.
   */
  async appendRetrievalEvidence(
    _workspaceId: string,
    _contextId: string,
    runId: string,
    evidence: readonly RagV2Evidence[],
  ): Promise<void> {
    this.storedEvidence.push(...structuredClone(evidence).map(value => ({ runId, evidence: value })));
  }

  /**
   * Overwrites the retrieval run with its final record.
   * @param run - Final run record to store; cloned.
   * @returns Resolves once the run is stored.
   * @throws Never.
   */
  async finishRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  /**
   * Appends an evaluation run to the in-memory audit trail.
   * @param input - Evaluation record: ids and signatures of the run, its configuration, computed metrics, and creation/completion timestamps.
   * @returns Resolves once the run is stored.
   * @throws Never.
   */
  async saveEvaluationRun(input: {
    id: string;
    workspaceId: string;
    contextId: string;
    generationId: string;
    embeddingSignature: string;
    rerankerModel?: string;
    configuration: unknown;
    metrics: Record<string, unknown>;
    createdAt: string;
    completedAt: string;
  }): Promise<void> {
    this.evaluationRuns.push(structuredClone(input));
  }

  /**
   * Appends a regex audit record to the in-memory audit trail.
   * @param run - Regex run record to store; cloned.
   * @returns Resolves once the run is stored.
   * @throws Never.
   */
  async saveRegexRun(run: RagV2RegexRunRecord): Promise<void> {
    this.regexRuns.push(structuredClone(run));
  }

  /**
   * Collects candidate records at a granularity level for searching.
   *
   * Candidates must belong to the scope's generation, workspace, and
   * context, pass the ACL-token, document-type, jurisdiction, and as-of-date
   * filters, and satisfy any id restrictions in the scope. Collection-level
   * candidates are kept only when at least one authorized member document
   * passes the same filters. The returned records are plain view objects
   * (collection and document text is the title plus routing summary), not
   * ranked hits.
   * @param level - Granularity to collect.
   * @param scope - Authorization, filtering, and limit constraints.
   * @returns Candidate records in map insertion order.
   * @throws Never.
   */
  private searchRecords(level: RagV2Level, scope: RagV2SearchScope): Array<{
    id: string;
    level: RagV2Level;
    documentId: string;
    documentVersionId: string;
    sectionId?: string;
    passageId?: string;
    path: string;
    title: string;
    headingPath: string[];
    startByte?: number;
    endByte?: number;
    startLine?: number;
    endLine?: number;
    language: string;
    text: string;
    searchText?: string;
    contentSha256: string;
    sourceId?: string;
    sourceVersionId?: string;
    objectPath?: string;
    lineIndexPath?: string;
  }> {
    const activeVersions = new Set(this.generationDocuments.get(scope.generationId)?.values() ?? []);
    const documentsByVersion = this.documents;
    if (level === 'collection') {
      const collectionHasAuthorizedMember = (collectionId: string): boolean => [...documentsByVersion.values()].some(document =>
        activeVersions.has(document.documentVersionId)
        && document.workspaceId === scope.workspaceId
        && document.contextId === scope.contextId
        && document.collectionId === collectionId
        && (!scope.authorizationTokens || document.aclTokens.some(token => scope.authorizationTokens!.includes(token)))
        && (!scope.documentIds || scope.documentIds.includes(document.documentId))
        && (!scope.documentTypes || scope.documentTypes.includes(document.documentType.toLocaleLowerCase()))
        && (!scope.jurisdictions || Boolean(document.jurisdiction && scope.jurisdictions.includes(document.jurisdiction.toLocaleLowerCase())))
        && (!scope.asOfDate || (
          (!document.publicationDate || document.publicationDate <= scope.asOfDate)
          && (!document.validFrom || document.validFrom <= scope.asOfDate)
          && (!document.validTo || document.validTo >= scope.asOfDate)
        )));
      return [...this.collections.values()]
        .filter(collection => collection.generationId === scope.generationId
          && collection.workspaceId === scope.workspaceId
          && collection.contextId === scope.contextId
          && collectionHasAuthorizedMember(collection.collectionId)
          && (!scope.collectionIds || scope.collectionIds.includes(collection.collectionId)))
        .map(collection => ({
          id: collection.collectionVersionId,
          level,
          documentId: collection.collectionId,
          documentVersionId: collection.collectionVersionId,
          path: `collection:${collection.collectionId}`,
          title: collection.title,
          headingPath: [],
          language: 'und',
          text: `${collection.title}\n${collection.routingSummary}`,
          contentSha256: collection.contentSha256,
        }));
    }
    if (level === 'document') {
      return [...this.documents.values()]
        .filter(document =>
          activeVersions.has(document.documentVersionId)
          && document.workspaceId === scope.workspaceId
          && document.contextId === scope.contextId
          && (!scope.authorizationTokens || document.aclTokens.some(token => scope.authorizationTokens!.includes(token)))
          && (!scope.documentTypes || scope.documentTypes.some(value => value.toLocaleLowerCase() === document.documentType.toLocaleLowerCase()))
          && (!scope.jurisdictions || scope.jurisdictions.some(value => value.toLocaleLowerCase() === document.jurisdiction?.toLocaleLowerCase()))
          && (!scope.asOfDate || (
            (!document.publicationDate || document.publicationDate <= scope.asOfDate)
            && (!document.validFrom || document.validFrom <= scope.asOfDate)
            && (!document.validTo || document.validTo >= scope.asOfDate)
          ))
          && (!scope.collectionIds || Boolean(document.collectionId && scope.collectionIds.includes(document.collectionId)))
          && (!scope.documentIds || scope.documentIds.includes(document.documentId)))
        .map(document => ({
          id: document.documentVersionId,
          level,
          documentId: document.documentId,
          documentVersionId: document.documentVersionId,
          path: document.path,
          title: document.title,
          headingPath: [],
          language: Object.entries(document.languageDistribution).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'und',
          text: `${document.title}\n${document.routingSummary}`,
          contentSha256: document.contentSha256,
          ...(document.sourceId ? { sourceId: document.sourceId } : {}),
          ...(document.sourceVersionId ? { sourceVersionId: document.sourceVersionId } : {}),
          objectPath: document.objectPath,
          lineIndexPath: document.lineIndexPath,
        }));
    }
    if (level === 'section') {
      return [...this.sections.values()]
        .filter(section =>
          activeVersions.has(section.documentVersionId)
          && section.workspaceId === scope.workspaceId
          && section.contextId === scope.contextId
          && (!scope.authorizationTokens || documentsByVersion.get(section.documentVersionId)!.aclTokens.some(token => scope.authorizationTokens!.includes(token)))
          && (!scope.documentTypes || scope.documentTypes.some(value => value.toLocaleLowerCase() === documentsByVersion.get(section.documentVersionId)!.documentType.toLocaleLowerCase()))
          && (!scope.jurisdictions || scope.jurisdictions.some(value => value.toLocaleLowerCase() === documentsByVersion.get(section.documentVersionId)!.jurisdiction?.toLocaleLowerCase()))
          && (!scope.asOfDate || (() => {
            const document = documentsByVersion.get(section.documentVersionId)!;
            return (!document.publicationDate || document.publicationDate <= scope.asOfDate!)
              && (!document.validFrom || document.validFrom <= scope.asOfDate!)
              && (!document.validTo || document.validTo >= scope.asOfDate!);
          })())
          && (!scope.collectionIds || Boolean(documentsByVersion.get(section.documentVersionId)!.collectionId
            && scope.collectionIds.includes(documentsByVersion.get(section.documentVersionId)!.collectionId!)))
          && (!scope.documentIds || scope.documentIds.includes(section.documentId))
          && (!scope.sectionIds || scope.sectionIds.includes(section.sectionId)))
        .map(section => {
          const document = documentsByVersion.get(section.documentVersionId)!;
          return {
            id: section.sectionId,
            level,
            documentId: section.documentId,
            documentVersionId: section.documentVersionId,
            sectionId: section.sectionId,
            path: document.path,
            title: document.title,
            headingPath: section.headingPath,
            startByte: section.startByte,
            endByte: section.endByte,
            startLine: section.startLine,
            endLine: section.endLine,
            language: section.language,
            text: `${section.headingText}\n${section.routingSummary}`,
            contentSha256: section.contentSha256,
            ...(document.sourceId ? { sourceId: document.sourceId } : {}),
            ...(document.sourceVersionId ? { sourceVersionId: document.sourceVersionId } : {}),
            objectPath: document.objectPath,
            lineIndexPath: document.lineIndexPath,
          };
        });
    }
    return [...this.passages.values()]
      .filter(passage =>
        activeVersions.has(passage.documentVersionId)
        && passage.workspaceId === scope.workspaceId
        && passage.contextId === scope.contextId
        && (!scope.authorizationTokens || documentsByVersion.get(passage.documentVersionId)!.aclTokens.some(token => scope.authorizationTokens!.includes(token)))
        && (!scope.documentTypes || scope.documentTypes.some(value => value.toLocaleLowerCase() === documentsByVersion.get(passage.documentVersionId)!.documentType.toLocaleLowerCase()))
        && (!scope.jurisdictions || scope.jurisdictions.some(value => value.toLocaleLowerCase() === documentsByVersion.get(passage.documentVersionId)!.jurisdiction?.toLocaleLowerCase()))
        && (!scope.asOfDate || (() => {
          const document = documentsByVersion.get(passage.documentVersionId)!;
          return (!document.publicationDate || document.publicationDate <= scope.asOfDate!)
            && (!document.validFrom || document.validFrom <= scope.asOfDate!)
            && (!document.validTo || document.validTo >= scope.asOfDate!);
        })())
        && (!scope.collectionIds || Boolean(documentsByVersion.get(passage.documentVersionId)!.collectionId
          && scope.collectionIds.includes(documentsByVersion.get(passage.documentVersionId)!.collectionId!)))
        && (!scope.documentIds || scope.documentIds.includes(passage.documentId))
        && (!scope.sectionIds || scope.sectionIds.includes(passage.sectionId)))
      .map(passage => {
        const document = documentsByVersion.get(passage.documentVersionId)!;
        return {
          id: passage.passageId,
          level,
          documentId: passage.documentId,
          documentVersionId: passage.documentVersionId,
          sectionId: passage.sectionId,
          passageId: passage.passageId,
          path: document.path,
          title: document.title,
          headingPath: passage.headingPath,
          startByte: passage.startByte,
          endByte: passage.endByte,
          startLine: passage.startLine,
          endLine: passage.endLine,
          language: passage.language,
          text: passage.text,
          ...(passage.lexicalText ? { searchText: passage.lexicalText } : {}),
          contentSha256: passage.contentSha256,
          ...(document.sourceId ? { sourceId: document.sourceId } : {}),
          ...(document.sourceVersionId ? { sourceVersionId: document.sourceVersionId } : {}),
          objectPath: document.objectPath,
          lineIndexPath: document.lineIndexPath,
        };
      });
  }

  /**
   * Wraps a candidate record into a ranked hit.
   * @param record - Candidate record from {@link MemoryRagV2Repository.searchRecords}.
   * @param retriever - Retriever identity recorded on the hit.
   * @param retrieverRank - 1-based position of the hit within the retriever's result.
   * @param retrieverScore - Raw retriever score assigned to the hit.
   * @returns The record fields plus retriever identity, rank, score, and a single retrieval reason.
   * @throws Never.
   */
  private toHit(
    record: ReturnType<MemoryRagV2Repository['searchRecords']>[number],
    retriever: string,
    retrieverRank: number,
    retrieverScore: number,
  ): RagV2RankedHit {
    return {
      ...record,
      retriever,
      retrieverRank,
      retrieverScore,
      retrievalReasons: [`${retriever} rank ${retrieverRank}`],
    };
  }
}

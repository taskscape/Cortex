import { createHash } from 'node:crypto';
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
  RagV2Publication,
  RagV2Repository,
  RagV2RegexRunRecord,
  RagV2RetrievalRunRecord,
  RagV2SearchScope,
  RagV2StoredRetrievalHit,
} from './repository.js';

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

function lexicalScore(query: string, text: string): number {
  const queryTerms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (queryTerms.size === 0 || terms.length === 0) return 0;
  let matches = 0;
  for (const term of terms) if (queryTerms.has(term)) matches++;
  return matches / Math.sqrt(queryTerms.size * terms.length);
}

function key(workspaceId: string, contextId: string): string {
  return `${workspaceId}\0${contextId}`;
}

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

  async initialize(vectorizer: RagV2VectorizerInfo): Promise<void> {
    this.vectorizer = structuredClone(vectorizer);
  }
  async close(): Promise<void> {}

  async beginGeneration(workspaceId: string, contextId: string, generationId: string): Promise<void> {
    const publicationKey = key(workspaceId, contextId);
    const values = this.publications.get(publicationKey) ?? [];
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
    const active = values.find(value => value.active);
    this.generationDocuments.set(
      generationId,
      active ? new Map(this.generationDocuments.get(active.generationId) ?? []) : new Map(),
    );
  }

  async activePublication(workspaceId: string, contextId: string): Promise<RagV2Publication | undefined> {
    return this.publications.get(key(workspaceId, contextId))?.find(value => value.active);
  }

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

  async createJob(job: RagV2Job): Promise<void> {
    this.jobs.set(key(job.workspaceId, job.contextId), structuredClone(job));
  }

  async updateJob(job: RagV2Job): Promise<void> {
    this.jobs.set(key(job.workspaceId, job.contextId), structuredClone(job));
  }

  async currentJob(workspaceId: string, contextId: string): Promise<RagV2Job | undefined> {
    const job = this.jobs.get(key(workspaceId, contextId));
    return job ? structuredClone(job) : undefined;
  }

  async upsertJobItem(item: RagV2JobItem): Promise<void> {
    this.jobItems.set(`${item.jobId}\0${item.path}`, structuredClone(item));
  }

  async countGenerationDocuments(workspaceId: string, contextId: string, generationId?: string): Promise<number> {
    const generation = generationId ?? (await this.activePublication(workspaceId, contextId))?.generationId;
    return generation ? this.generationDocuments.get(generation)?.size ?? 0 : 0;
  }

  async listFingerprints(workspaceId: string, contextId: string): Promise<RagV2DocumentFingerprint[]> {
    const active = await this.activePublication(workspaceId, contextId);
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

  async beginDocument(generationId: string, document: RagV2DocumentRecord): Promise<void> {
    this.documents.set(document.documentVersionId, structuredClone(document));
    this.generationDocuments.get(generationId)?.set(document.documentId, document.documentVersionId);
  }

  async appendSections(sections: readonly RagV2SectionRecord[]): Promise<void> {
    for (const section of sections) this.sections.set(section.sectionId, structuredClone(section));
  }

  async appendPassages(passages: readonly RagV2PassageRecord[]): Promise<void> {
    for (const passage of passages) this.passages.set(passage.passageId, structuredClone(passage));
  }

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

  async finishDocument(generationId: string, document: RagV2DocumentRecord): Promise<void> {
    this.documents.set(document.documentVersionId, structuredClone(document));
    this.generationDocuments.get(generationId)?.set(document.documentId, document.documentVersionId);
  }

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

  async lexicalSearch(level: RagV2Level, query: string, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    return this.searchRecords(level, scope)
      .map(record => ({ record, score: lexicalScore(query, record.searchText ?? record.text) }))
      .filter(value => value.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, scope.limit)
      .map(({ record, score }, index) => this.toHit(record, `${level}_lexical`, index + 1, score));
  }

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

  async grepDocuments(
    workspaceId: string,
    contextId: string,
    generationId: string,
    documentVersionIds: readonly string[],
    pattern: string,
    authorizationTokens: readonly string[],
    limit: number,
  ): Promise<RagV2RankedHit[]> {
    const expression = new RegExp(pattern, 'giu');
    return this.searchRecords('passage', {
      workspaceId,
      contextId,
      generationId,
      authorizationTokens: [...authorizationTokens],
      documentIds: [...this.documents.values()]
        .filter(document => documentVersionIds.includes(document.documentVersionId))
        .map(document => document.documentId),
      limit,
    })
      .filter(record => {
        expression.lastIndex = 0;
        return expression.test(record.text);
      })
      .slice(0, limit)
      .map((record, index) => this.toHit(record, 'narrowed_regex', index + 1, 1));
  }

  async createRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async appendRetrievalHits(
    _workspaceId: string,
    _contextId: string,
    hits: readonly RagV2StoredRetrievalHit[],
  ): Promise<void> {
    this.storedHits.push(...structuredClone(hits));
  }

  async appendRetrievalEvidence(
    _workspaceId: string,
    _contextId: string,
    runId: string,
    evidence: readonly RagV2Evidence[],
  ): Promise<void> {
    this.storedEvidence.push(...structuredClone(evidence).map(value => ({ runId, evidence: value })));
  }

  async finishRetrievalRun(run: RagV2RetrievalRunRecord): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

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

  async saveRegexRun(run: RagV2RegexRunRecord): Promise<void> {
    this.regexRuns.push(structuredClone(run));
  }

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

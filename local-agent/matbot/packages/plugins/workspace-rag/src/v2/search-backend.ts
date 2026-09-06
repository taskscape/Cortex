import type {
  RagV2Level,
  RagV2RankedHit,
  RagV2RetrievalPlan,
} from './types.js';
import type { RagV2Repository, RagV2SearchScope } from './repository.js';

/**
 * A batch of records to index into a search backend for one generation.
 */
export interface SearchRecordBatch {
  generationId: string;
  level: RagV2Level;
  records: Array<{
    id: string;
    documentId: string;
    documentVersionId: string;
    sectionId?: string;
    passageId?: string;
    workspaceId: string;
    contextId: string;
    aclTokens: string[];
    path: string;
    title: string;
    documentType?: string;
    jurisdiction?: string;
    publicationDate?: string;
    validFrom?: string;
    validTo?: string;
    headingPath: string[];
    language: string;
    text: string;
    contentSha256: string;
    embedding?: number[];
    startByte?: number;
    endByte?: number;
    startLine?: number;
    endLine?: number;
  }>;
}

/**
 * Result of validating that a generation is fully indexed.
 */
export interface SearchBackendValidationReport {
  valid: boolean;
  generationId: string;
  records: number;
  errors: string[];
}

/**
 * Contract for pluggable hybrid (lexical + dense) search backends.
 */
export interface HybridSearchBackend {
  readonly kind: 'postgres-pgvector' | 'opensearch';
  /**
   * Indexes one batch of records for the generation.
   * @param batch - Records to index.
   * @param signal - Abort signal cancelling the write.
   */
  indexGeneration(batch: SearchRecordBatch, signal?: AbortSignal): Promise<void>;
  validateGeneration(generationId: string): Promise<SearchBackendValidationReport>;
  publishGeneration(generationId: string): Promise<void>;
  lexicalSearch(plan: RagV2RetrievalPlan, scope: RagV2SearchScope): Promise<RagV2RankedHit[]>;
  denseSearch(
    plan: RagV2RetrievalPlan,
    queryVector: readonly number[],
    scope: RagV2SearchScope,
  ): Promise<RagV2RankedHit[]>;
  exactSearch(plan: RagV2RetrievalPlan, scope: RagV2SearchScope): Promise<RagV2RankedHit[]>;
  deleteRetiredGeneration(generationId: string): Promise<void>;
}

/**
 * Measured performance figures comparing candidate backends.
 */
export interface SearchBackendMeasurements {
  lexicalNdcg: number;
  recallAtK: number;
  p95CandidateLatencyMs: number;
  controlPlaneP95LatencyMs: number;
  indexBytes: number;
  authorizationLeakageRate: number;
  citationCorrectness: number;
}

/**
 * Inputs to the deterministic OpenSearch adoption decision.
 */
export interface OpenSearchAdoptionGateInput {
  postgres: SearchBackendMeasurements;
  opensearch: SearchBackendMeasurements;
  targets: {
    lexicalNdcg: number;
    recallAtK: number;
    p95CandidateLatencyMs: number;
    maxControlPlaneRegressionMs: number;
    maxIndexBytes?: number;
  };
  nativeHybridBenefit: number;
  minimumMaterialBenefit: number;
  operationalApproval: boolean;
}

/**
 * Outcome of the adoption-gate evaluation.
 */
export interface OpenSearchAdoptionGateResult {
  recommendation: 'keep_postgres' | 'promote_opensearch';
  postgresTriggers: string[];
  failedSafetyGates: string[];
  measurements: OpenSearchAdoptionGateInput;
}

/**
 * Deterministically decides whether OpenSearch should be adopted based on
 * measured recall/latency against the Postgres baseline and thresholds.
 * Promotion requires at least one Postgres trigger and zero failed safety
 * gates.
 * @param input - Measurements, baseline, and thresholds.
 * @returns The adoption verdict with trigger/safety-gate reasons and a
 *   structured snapshot of the input measurements.
 * @throws Never.
 */
export function evaluateOpenSearchAdoption(
  input: OpenSearchAdoptionGateInput,
): OpenSearchAdoptionGateResult {
  const triggers: string[] = [];
  const failedSafetyGates: string[] = [];
  if (input.postgres.lexicalNdcg < input.targets.lexicalNdcg
    || input.postgres.recallAtK < input.targets.recallAtK) {
    triggers.push('PostgreSQL lexical relevance remains below the measured acceptance target.');
  }
  if (input.postgres.p95CandidateLatencyMs > input.targets.p95CandidateLatencyMs) {
    triggers.push('PostgreSQL P95 candidate latency misses the measured target.');
  }
  if (
    input.postgres.controlPlaneP95LatencyMs
    > input.opensearch.controlPlaneP95LatencyMs + input.targets.maxControlPlaneRegressionMs
  ) {
    triggers.push('Search index maintenance materially disrupts PostgreSQL control-plane latency.');
  }
  if (input.targets.maxIndexBytes !== undefined && input.postgres.indexBytes > input.targets.maxIndexBytes) {
    triggers.push('PostgreSQL index size exceeds the measured topology budget.');
  }
  if (input.nativeHybridBenefit >= input.minimumMaterialBenefit) {
    triggers.push('OpenSearch native hybrid retrieval has a measured material benefit.');
  }
  if (input.opensearch.authorizationLeakageRate !== 0) {
    failedSafetyGates.push('OpenSearch authorization leakage must be zero.');
  }
  if (input.opensearch.citationCorrectness !== 1) {
    failedSafetyGates.push('OpenSearch citations must be mechanically correct for every evaluated hit.');
  }
  if (input.opensearch.lexicalNdcg < input.targets.lexicalNdcg
    || input.opensearch.recallAtK < input.targets.recallAtK) {
    failedSafetyGates.push('OpenSearch relevance does not pass the target judgment set.');
  }
  if (input.opensearch.p95CandidateLatencyMs > input.targets.p95CandidateLatencyMs) {
    failedSafetyGates.push('OpenSearch P95 candidate latency does not pass the target.');
  }
  if (!input.operationalApproval) {
    failedSafetyGates.push('The additional stateful service has not received explicit operational approval.');
  }
  return {
    recommendation: triggers.length > 0 && failedSafetyGates.length === 0
      ? 'promote_opensearch'
      : 'keep_postgres',
    postgresTriggers: triggers,
    failedSafetyGates,
    measurements: structuredClone(input),
  };
}

/**
 * {@link HybridSearchBackend} delegating lexical/dense/exact search to the
 * Postgres repository (the default backend).
 */
export class PostgresHybridSearchBackend implements HybridSearchBackend {
  readonly kind = 'postgres-pgvector' as const;
  private readonly repository: RagV2Repository;
  private readonly signature: string;
  private readonly dimensions: number;

  /**
   * Captures the repository and vectorizer identity used by all searches.
   * @param repository - Repository providing the actual search execution.
   * @param signature - Vectorizer signature reported to the repository on
   *   dense searches.
   * @param dimensions - Embedding dimensionality reported to the repository.
   * @throws Never.
   */
  constructor(repository: RagV2Repository, signature: string, dimensions: number) {
    this.repository = repository;
    this.signature = signature;
    this.dimensions = dimensions;
  }

  /**
   * Intentionally unsupported: PostgreSQL generation indexing is performed
   * transactionally by {@link RagV2Repository}.
   * @param _batch - Unused; the repository indexes generations itself.
   * @returns A promise that never resolves normally.
   * @throws Error - always.
   */
  async indexGeneration(_batch: SearchRecordBatch): Promise<void> {
    throw new Error('PostgreSQL generation indexing is performed transactionally by RagV2Repository.');
  }

  /**
   * Always reports valid: PostgreSQL validation is owned by the repository's
   * own {@link RagV2Repository.validateGeneration}.
   * @param generationId - Generation id echoed back in the report.
   * @returns A report with `valid: true` and a record count of 0.
   * @throws Never.
   */
  async validateGeneration(generationId: string): Promise<SearchBackendValidationReport> {
    return { valid: true, generationId, records: 0, errors: [] };
  }

  /**
   * Intentionally unsupported: PostgreSQL publication requires workspace and
   * context and is managed by {@link RagV2Repository}.
   * @param _generationId - Unused.
   * @returns A promise that never resolves normally.
   * @throws Error - always.
   */
  async publishGeneration(_generationId: string): Promise<void> {
    throw new Error('PostgreSQL publication requires workspace and context and is managed by RagV2Repository.');
  }

  /**
   * Delegates to the repository's passage-level lexical search using the
   * plan's original query text.
   * @param plan - Plan supplying the query text.
   * @param scope - Authorization and result-size bounds.
   * @returns Repository-ranked hits.
   * @throws Error - if the repository search fails.
   */
  async lexicalSearch(plan: RagV2RetrievalPlan, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    return this.repository.lexicalSearch('passage', plan.originalQuery, scope);
  }

  /**
   * Delegates to the repository's passage-level dense search, identifying the
   * vectorizer by this backend's signature and dimensionality.
   * @param _plan - Unused; the vector alone drives the search.
   * @param queryVector - Query embedding to match.
   * @param scope - Authorization and result-size bounds.
   * @returns Repository-ranked hits.
   * @throws Error - if the repository search fails.
   */
  async denseSearch(
    _plan: RagV2RetrievalPlan,
    queryVector: readonly number[],
    scope: RagV2SearchScope,
  ): Promise<RagV2RankedHit[]> {
    return this.repository.denseSearch(
      'passage',
      queryVector,
      {
        backend: 'postgres-pgvector',
        model: this.signature,
        dimensions: this.dimensions,
        signature: this.signature,
      },
      scope,
    );
  }

  /**
   * Delegates to the repository's exact search over the plan's extracted
   * references and quoted phrases.
   * @param plan - Plan supplying the reference/quote strings.
   * @param scope - Authorization and result-size bounds.
   * @returns Repository-ranked hits.
   * @throws Error - if the repository search fails.
   */
  async exactSearch(plan: RagV2RetrievalPlan, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    return this.repository.exactSearch([...plan.exactReferences, ...plan.quotedPhrases], scope);
  }

  /**
   * No-op: PostgreSQL retirement is controlled by the publication catalog and
   * the retention job.
   * @param _generationId - Unused.
   * @returns A promise that resolves immediately.
   * @throws Never.
   */
  async deleteRetiredGeneration(_generationId: string): Promise<void> {
    // PostgreSQL retirement is controlled by the publication catalog and retention job.
  }
}

/**
 * Connection settings for the OpenSearch cluster: endpoint, optional index
 * name prefix, and optional basic-auth credentials.
 */
interface OpenSearchOptions {
  baseUrl: string;
  indexPrefix?: string;
  username?: string;
  password?: string;
}

/**
 * {@link HybridSearchBackend} backed by an OpenSearch cluster.
 */
export class OpenSearchHybridSearchBackend implements HybridSearchBackend {
  readonly kind = 'opensearch' as const;
  private readonly baseUrl: URL;
  private readonly indexPrefix: string;
  private readonly authorization: string | undefined;

  /**
   * Normalizes the endpoint URL and index prefix (invalid characters become
   * `-`) and prepares optional basic-auth credentials.
   * @param options - Cluster endpoint, optional index prefix (defaults to
   *   `cortex-rag-v2`), and optional username/password.
   * @throws TypeError - if `options.baseUrl` is not a valid absolute URL.
   */
  constructor(options: OpenSearchOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.indexPrefix = (options.indexPrefix ?? 'cortex-rag-v2').replace(/[^a-z0-9_-]/giu, '-').toLowerCase();
    this.authorization = options.username
      ? `Basic ${Buffer.from(`${options.username}:${options.password ?? ''}`).toString('base64')}`
      : undefined;
  }

  /**
   * Ensures the generation/level index exists (deriving the vector field's
   * dimensionality from the first record that has an embedding), then writes
   * the batch as one NDJSON bulk request without refreshing.
   * @param batch - Records to index for one generation and level.
   * @param signal - Optional abort signal forwarded to the HTTP request.
   * @returns A promise resolving once the bulk response is accepted.
   * @throws Error - on any HTTP failure, or when the bulk response reports
   *   per-item errors.
   */
  async indexGeneration(batch: SearchRecordBatch, signal?: AbortSignal): Promise<void> {
    const index = this.indexName(batch.generationId, batch.level);
    await this.ensureIndex(index, batch.records.find(record => record.embedding)?.embedding?.length);
    const body = batch.records.flatMap(record => [
      JSON.stringify({ index: { _index: index, _id: record.id } }),
      JSON.stringify({ ...record, generationId: batch.generationId, level: batch.level }),
    ]).join('\n') + '\n';
    const response = await this.request('/_bulk?refresh=false', {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
      ...(signal ? { signal } : {}),
    });
    const result = await response.json() as { errors?: boolean };
    if (result.errors) throw new Error('OpenSearch bulk indexing reported item failures.');
  }

  /**
   * Counts records in each per-level index for the generation, collecting
   * per-level request failures as errors instead of throwing; the generation
   * is invalid if any error occurs or no records were found.
   * @param generationId - Generation to validate.
   * @returns The validation report with the summed record count and errors.
   * @throws Error - if a count response body is not valid JSON.
   */
  async validateGeneration(generationId: string): Promise<SearchBackendValidationReport> {
    let records = 0;
    const errors: string[] = [];
    for (const level of ['document', 'section', 'passage'] as const) {
      const response = await this.request(`/${this.indexName(generationId, level)}/_count`, { method: 'GET' })
        .catch(error => {
          errors.push(`${level}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        });
      if (!response) continue;
      const value = await response.json() as { count?: number };
      records += Number(value.count ?? 0);
    }
    if (records === 0) errors.push('Generation contains no searchable records.');
    return { valid: errors.length === 0, generationId, records, errors };
  }

  /**
   * Atomically repoints each level's `<prefix>-<level>-read` alias to the
   * generation's index via a single `_aliases` request.
   * @param generationId - Generation to publish.
   * @returns A promise resolving once the alias swap is committed.
   * @throws Error - on HTTP failure.
   */
  async publishGeneration(generationId: string): Promise<void> {
    const actions: unknown[] = [];
    for (const level of ['document', 'section', 'passage'] as const) {
      const alias = `${this.indexPrefix}-${level}-read`;
      actions.push({ remove: { alias, index: `${this.indexPrefix}-*-*`, must_exist: false } });
      actions.push({ add: { alias, index: this.indexName(generationId, level) } });
    }
    await this.request('/_aliases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actions }),
    });
  }

  /**
   * Runs a boosted multi-match lexical query (`title`, `headingPath`, `text`)
   * against the passage read alias, filtered by the scope.
   * @param plan - Plan supplying the query text.
   * @param scope - Authorization and result-size bounds.
   * @returns Hits in OpenSearch relevance order, ranked per lane.
   * @throws Error - on HTTP failure.
   */
  async lexicalSearch(plan: RagV2RetrievalPlan, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    return this.search('passage', scope, {
      size: scope.limit,
      query: {
        bool: {
          must: [{
            multi_match: {
              query: plan.originalQuery,
              fields: ['title^3', 'headingPath^2', 'text'],
              type: 'best_fields',
            },
          }],
          filter: this.filters(scope),
        },
      },
    }, 'passage_lexical');
  }

  /**
   * Runs a k-NN query against the passage read alias with the scope filters.
   * @param _plan - Unused; the vector alone drives the search.
   * @param queryVector - Query embedding to match.
   * @param scope - Authorization and result-size bounds; `limit` sets `k`.
   * @returns Hits in OpenSearch similarity order, ranked per lane.
   * @throws Error - on HTTP failure.
   */
  async denseSearch(
    _plan: RagV2RetrievalPlan,
    queryVector: readonly number[],
    scope: RagV2SearchScope,
  ): Promise<RagV2RankedHit[]> {
    return this.search('passage', scope, {
      size: scope.limit,
      query: {
        bool: {
          must: [{
            knn: {
              embedding: {
                vector: queryVector,
                k: scope.limit,
              },
            },
          }],
          filter: this.filters(scope),
        },
      },
    }, 'passage_dense');
  }

  /**
   * Runs a phrase-match query over the plan's references and quoted phrases;
   * returns no hits when neither list contributes a value.
   * @param plan - Plan supplying the reference/quote strings.
   * @param scope - Authorization and result-size bounds.
   * @returns Hits containing at least one phrase, in relevance order.
   * @throws Error - on HTTP failure.
   */
  async exactSearch(plan: RagV2RetrievalPlan, scope: RagV2SearchScope): Promise<RagV2RankedHit[]> {
    const values = [...plan.exactReferences, ...plan.quotedPhrases];
    if (values.length === 0) return [];
    return this.search('passage', scope, {
      size: scope.limit,
      query: {
        bool: {
          should: values.map(value => ({ match_phrase: { text: value } })),
          minimum_should_match: 1,
          filter: this.filters(scope),
        },
      },
    }, 'exact_reference');
  }

  /**
   * Deletes the document, section, and passage indexes of the generation.
   * @param generationId - Generation whose indexes are removed.
   * @returns A promise resolving once all three deletions complete.
   * @throws Error - on HTTP failure.
   */
  async deleteRetiredGeneration(generationId: string): Promise<void> {
    for (const level of ['document', 'section', 'passage'] as const) {
      await this.request(`/${this.indexName(generationId, level)}`, { method: 'DELETE' });
    }
  }

  /**
   * Creates the index with a strict mapping when it does not exist; the
   * `resource_already_exists_exception` failure is tolerated while any other
   * failure propagates.
   * @param index - Fully qualified index name.
   * @param dimensions - Optional embedding dimensionality; when supplied, an
   *   on-disk cosine-similarity k-NN vector field is mapped.
   * @returns A promise resolving once the mapping is applied.
   * @throws Error - if index creation fails for any reason other than the
   *   index already existing.
   */
  private async ensureIndex(index: string, dimensions?: number): Promise<void> {
    const mapping = {
      settings: { index: { knn: true } },
      mappings: {
        dynamic: 'strict',
        properties: {
          id: { type: 'keyword' },
          generationId: { type: 'keyword' },
          level: { type: 'keyword' },
          documentId: { type: 'keyword' },
          documentVersionId: { type: 'keyword' },
          sectionId: { type: 'keyword' },
          passageId: { type: 'keyword' },
          workspaceId: { type: 'keyword' },
          contextId: { type: 'keyword' },
          aclTokens: { type: 'keyword' },
          path: { type: 'keyword' },
          title: { type: 'text' },
          documentType: { type: 'keyword' },
          jurisdiction: { type: 'keyword' },
          publicationDate: { type: 'date' },
          validFrom: { type: 'date' },
          validTo: { type: 'date' },
          headingPath: { type: 'text' },
          language: { type: 'keyword' },
          text: { type: 'text' },
          contentSha256: { type: 'keyword' },
          startByte: { type: 'long' },
          endByte: { type: 'long' },
          startLine: { type: 'long' },
          endLine: { type: 'long' },
          ...(dimensions ? {
            embedding: {
              type: 'knn_vector',
              dimension: dimensions,
              mode: 'on_disk',
              space_type: 'cosinesimil',
            },
          } : {}),
        },
      },
    };
    await this.request(`/${index}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mapping),
    }).catch(error => {
      if (!(error instanceof Error) || !error.message.includes('resource_already_exists_exception')) throw error;
    });
  }

  /**
   * Builds the OpenSearch filter clauses shared by all query types: tenant
   * identity, ACL tokens, optional id/type/jurisdiction terms, and — when an
   * as-of date is set — temporal validity over the publication and validity
   * windows (records without dates always pass).
   * @param scope - The search scope to translate.
   * @returns An array of OpenSearch filter clause objects.
   * @throws Never.
   */
  private filters(scope: RagV2SearchScope): unknown[] {
    return [
      { term: { workspaceId: scope.workspaceId } },
      { term: { contextId: scope.contextId } },
      { term: { generationId: scope.generationId } },
      { terms: { aclTokens: scope.authorizationTokens ?? [`workspace:${scope.workspaceId}`] } },
      ...(scope.documentIds ? [{ terms: { documentId: scope.documentIds } }] : []),
      ...(scope.sectionIds ? [{ terms: { sectionId: scope.sectionIds } }] : []),
      ...(scope.documentTypes ? [{ terms: { documentType: scope.documentTypes } }] : []),
      ...(scope.jurisdictions ? [{ terms: { jurisdiction: scope.jurisdictions } }] : []),
      ...(scope.asOfDate ? [{
        bool: {
          must: [
            {
              bool: {
                should: [
                  { bool: { must_not: { exists: { field: 'publicationDate' } } } },
                  { range: { publicationDate: { lte: scope.asOfDate } } },
                ],
                minimum_should_match: 1,
              },
            },
            {
              bool: {
                should: [
                  { bool: { must_not: { exists: { field: 'validFrom' } } } },
                  { range: { validFrom: { lte: scope.asOfDate } } },
                ],
                minimum_should_match: 1,
              },
            },
            {
              bool: {
                should: [
                  { bool: { must_not: { exists: { field: 'validTo' } } } },
                  { range: { validTo: { gte: scope.asOfDate } } },
                ],
                minimum_should_match: 1,
              },
            },
          ],
        },
      }] : []),
    ];
  }

  /**
   * Posts a prebuilt query body to the level's read alias and maps the
   * response into ranked hits with 1-based ranks.
   * @param level - Level whose read alias is queried.
   * @param _scope - Unused; filters and size are embedded in `body` by the
   *   callers.
   * @param body - The OpenSearch query body.
   * @param retriever - Lane name recorded on every hit.
   * @returns Hits in OpenSearch relevance order; missing source fields become
   *   empty strings or are omitted.
   * @throws Error - on HTTP failure.
   */
  private async search(
    level: RagV2Level,
    scope: RagV2SearchScope,
    body: unknown,
    retriever: string,
  ): Promise<RagV2RankedHit[]> {
    const response = await this.request(`/${this.indexPrefix}-${level}-read/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json() as {
      hits?: { hits?: Array<{ _id: string; _score: number; _source: Record<string, unknown> }> };
    };
    return (result.hits?.hits ?? []).map((value, index) => {
      const source = value._source;
      return {
        level,
        id: value._id,
        documentId: String(source['documentId']),
        documentVersionId: String(source['documentVersionId']),
        ...(source['sectionId'] ? { sectionId: String(source['sectionId']) } : {}),
        ...(source['passageId'] ? { passageId: String(source['passageId']) } : {}),
        path: String(source['path']),
        title: String(source['title']),
        headingPath: Array.isArray(source['headingPath']) ? source['headingPath'].map(String) : [],
        ...(Number.isFinite(Number(source['startByte'])) ? { startByte: Number(source['startByte']) } : {}),
        ...(Number.isFinite(Number(source['endByte'])) ? { endByte: Number(source['endByte']) } : {}),
        ...(Number.isFinite(Number(source['startLine'])) ? { startLine: Number(source['startLine']) } : {}),
        ...(Number.isFinite(Number(source['endLine'])) ? { endLine: Number(source['endLine']) } : {}),
        language: String(source['language'] ?? 'und'),
        text: String(source['text']),
        contentSha256: String(source['contentSha256']),
        retriever,
        retrieverRank: index + 1,
        retrieverScore: Number(value._score ?? 0),
        retrievalReasons: [`${retriever} rank ${index + 1}`],
      };
    });
  }

  /**
   * Builds the per-generation index name, sanitizing the generation id to
   * `[a-z0-9_-]` with `-` replacements.
   * @param generationId - Raw generation id.
   * @param level - Level component of the name.
   * @returns The `<prefix>-<level>-<generation>` index name.
   * @throws Never.
   */
  private indexName(generationId: string, level: RagV2Level): string {
    const generation = generationId.replace(/[^a-z0-9_-]/giu, '-').toLowerCase();
    return `${this.indexPrefix}-${level}-${generation}`;
  }

  /**
   * Performs one authenticated HTTP request against the cluster with a 30
   * second timeout, combining the caller's signal with the timeout signal.
   * @param pathname - Path appended to the base URL.
   * @param init - Fetch init; an authorization header is injected when
   *   credentials were configured.
   * @returns The raw response once the status is 2xx.
   * @throws Error - on non-2xx status (with up to 1,000 characters of the
   *   body), network failure, timeout, or abort.
   */
  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const url = new URL(pathname, this.baseUrl);
    const headers = new Headers(init.headers);
    if (this.authorization) headers.set('authorization', this.authorization);
    const timeout = AbortSignal.timeout(30_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await fetch(url, { ...init, headers, signal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(`OpenSearch HTTP ${response.status}: ${detail}`);
    }
    return response;
  }
}

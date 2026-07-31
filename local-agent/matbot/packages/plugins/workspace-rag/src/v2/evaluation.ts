export interface RagV2RelevanceJudgment {
  passageId: string;
  relevance: number;
  sectionId?: string;
  documentVersionId?: string;
  contentSha256?: string;
}

export interface RagV2EvaluationCase {
  id: string;
  category:
    | 'exact'
    | 'conceptual'
    | 'cross_language'
    | 'polish_morphology'
    | 'legal_reference'
    | 'as_of'
    | 'conflict'
    | 'not_present'
    | 'authorization'
    | 'large_document'
    | 'table_annex'
    | 'duplicate'
    | 'stale_source';
  query: string;
  judgments: RagV2RelevanceJudgment[];
  forbiddenPassageIds?: string[];
}

export interface RagV2CaseMetrics {
  caseId: string;
  category: string;
  recallAtK: number;
  precisionAtK: number;
  ndcgAtK: number;
  reciprocalRank: number;
  citationCorrectness: number;
  citationVersionCorrectness: number;
  routingRecall: number;
  evidenceFaithfulness: number;
  unsupportedConclusionRate: number;
  authorizationLeakage: number;
  expectedNoAnswer: boolean;
  returned: number;
}

export interface RagV2EvaluationMetrics {
  cases: number;
  k: number;
  recallAtK: number;
  precisionAtK: number;
  ndcgAtK: number;
  meanReciprocalRank: number;
  citationCorrectness: number;
  citationVersionCorrectness: number;
  routingRecall: number;
  evidenceFaithfulness: number;
  unsupportedConclusionRate: number;
  authorizationLeakageRate: number;
  byCategory: Record<string, Omit<RagV2EvaluationMetrics, 'byCategory'>>;
  caseMetrics: RagV2CaseMetrics[];
}

export interface RagV2EvaluatedEvidence {
  passageId: string;
  documentVersionId?: string;
  startByte?: number;
  endByte?: number;
  startLine?: number;
  endLine?: number;
  contentSha256?: string;
  sectionId?: string;
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function dcg(relevances: readonly number[]): number {
  return relevances.reduce(
    (sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2),
    0,
  );
}

function aggregate(cases: readonly RagV2CaseMetrics[], k: number): Omit<RagV2EvaluationMetrics, 'byCategory'> {
  return {
    cases: cases.length,
    k,
    recallAtK: average(cases.map(value => value.recallAtK)),
    precisionAtK: average(cases.map(value => value.precisionAtK)),
    ndcgAtK: average(cases.map(value => value.ndcgAtK)),
    meanReciprocalRank: average(cases.map(value => value.reciprocalRank)),
    citationCorrectness: average(cases.map(value => value.citationCorrectness)),
    citationVersionCorrectness: average(cases.map(value => value.citationVersionCorrectness)),
    routingRecall: average(cases.map(value => value.routingRecall)),
    evidenceFaithfulness: average(cases.map(value => value.evidenceFaithfulness)),
    unsupportedConclusionRate: average(cases.map(value => value.unsupportedConclusionRate)),
    authorizationLeakageRate: average(cases.map(value => value.authorizationLeakage)),
    caseMetrics: [...cases],
  };
}

export function evaluateRagV2Results(
  results: ReadonlyArray<{
    testCase: RagV2EvaluationCase;
    evidence: RagV2EvaluatedEvidence[];
    routedSectionIds?: string[];
  }>,
  k = 10,
): RagV2EvaluationMetrics {
  const safeK = Math.max(1, Math.floor(k));
  const caseMetrics = results.map(({ testCase, evidence, routedSectionIds }): RagV2CaseMetrics => {
    const top = evidence.slice(0, safeK);
    const relevance = new Map(testCase.judgments.map(value => [value.passageId, Math.max(0, value.relevance)]));
    const relevant = [...relevance.values()].filter(value => value > 0).length;
    const observed = top.map(value => relevance.get(value.passageId) ?? 0);
    const relevantRetrieved = observed.filter(value => value > 0).length;
    const ideal = [...relevance.values()].sort((left, right) => right - left).slice(0, safeK);
    const firstRelevant = observed.findIndex(value => value > 0);
    const mechanicallyValid = top.filter(value =>
      Boolean(value.documentVersionId)
      && Number.isSafeInteger(value.startByte)
      && Number.isSafeInteger(value.endByte)
      && value.endByte! > value.startByte!
      && Number.isSafeInteger(value.startLine)
      && Number.isSafeInteger(value.endLine)
      && value.endLine! >= value.startLine!
      && /^[a-f0-9]{64}$/u.test(value.contentSha256 ?? '')).length;
    const forbidden = new Set(testCase.forbiddenPassageIds ?? []);
    const versionCorrect = top.filter(value => {
      const judgment = testCase.judgments.find(item => item.passageId === value.passageId);
      if (!value.documentVersionId) return false;
      if (judgment?.documentVersionId && judgment.documentVersionId !== value.documentVersionId) return false;
      if (judgment?.contentSha256 && judgment.contentSha256 !== value.contentSha256) return false;
      return true;
    }).length;
    const relevantSections = new Set(
      testCase.judgments.filter(value => value.relevance > 0 && value.sectionId).map(value => value.sectionId!),
    );
    const routed = new Set(routedSectionIds ?? []);
    const routedRelevant = [...relevantSections].filter(value => routed.has(value)).length;
    return {
      caseId: testCase.id,
      category: testCase.category,
      recallAtK: relevant > 0 ? relevantRetrieved / relevant : top.length === 0 ? 1 : 0,
      precisionAtK: top.length > 0 ? relevantRetrieved / top.length : relevant === 0 ? 1 : 0,
      ndcgAtK: dcg(ideal) > 0 ? dcg(observed) / dcg(ideal) : top.length === 0 ? 1 : 0,
      reciprocalRank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : relevant === 0 && top.length === 0 ? 1 : 0,
      citationCorrectness: top.length > 0 ? mechanicallyValid / top.length : 1,
      citationVersionCorrectness: top.length > 0 ? versionCorrect / top.length : 1,
      routingRecall: relevantSections.size > 0
        ? routedRelevant / relevantSections.size
        : relevant > 0
          ? relevantRetrieved / relevant
          : 1,
      evidenceFaithfulness: top.length > 0
        ? relevantRetrieved / top.length
        : relevant === 0
          ? 1
          : 0,
      unsupportedConclusionRate: relevant === 0 && top.length > 0 ? 1 : 0,
      authorizationLeakage: top.some(value => forbidden.has(value.passageId)) ? 1 : 0,
      expectedNoAnswer: relevant === 0,
      returned: top.length,
    };
  });
  const byCategory: RagV2EvaluationMetrics['byCategory'] = {};
  for (const category of new Set(caseMetrics.map(value => value.category))) {
    byCategory[category] = aggregate(caseMetrics.filter(value => value.category === category), safeK);
  }
  return {
    ...aggregate(caseMetrics, safeK),
    byCategory,
  };
}

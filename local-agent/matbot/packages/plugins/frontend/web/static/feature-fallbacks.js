/** Inert bindings keep the chat shell usable when an optional capability is absent. */
window.cortexFeatureFallbacks={sources(host){const architectureSourceStatusEl = document.getElementById('architecture-source-status');
const architectureSourceRefreshBtn = document.getElementById('architecture-source-refresh');
const architectureSourceListEl = document.getElementById('architecture-source-list');
const architectureSourceDetailEl = document.getElementById('architecture-source-detail');
const architectureSourceHealthSummaryEl = document.getElementById('architecture-source-health-summary');
const architectureSourceHealthModalEl = document.getElementById('architecture-source-health-modal');
const architectureSourceHealthModalContentEl = document.getElementById('architecture-source-health-modal-content');
const architectureSourceHealthModalCloseBtn = document.getElementById('architecture-source-health-modal-close');
let architectureSourcesState = { sources: [], selected: null, citation: null, events: null, selectedEvent: null, healthReport: null, loaded: false };
let architectureSourcesLoadSeq = 0;
function sourceHealthFindings(){}
function sourceHealthSeverity(){}
function renderArchitectureSourceHealthSummary(){}
function openArchitectureSourceHealthModal(){return Promise.resolve();}
function renderArchitectureSourceList(){}
function renderArchitectureSourceDetail(){}
function selectArchitectureSource(){return Promise.resolve();}
function loadArchitectureSources(){return Promise.resolve();}
return {get architectureSourceStatusEl(){return architectureSourceStatusEl},
get architectureSourceRefreshBtn(){return architectureSourceRefreshBtn},
get architectureSourceListEl(){return architectureSourceListEl},
get architectureSourceDetailEl(){return architectureSourceDetailEl},
get architectureSourceHealthSummaryEl(){return architectureSourceHealthSummaryEl},
get architectureSourceHealthModalEl(){return architectureSourceHealthModalEl},
get architectureSourceHealthModalContentEl(){return architectureSourceHealthModalContentEl},
get architectureSourceHealthModalCloseBtn(){return architectureSourceHealthModalCloseBtn},
get architectureSourcesState(){return architectureSourcesState},set architectureSourcesState(value){architectureSourcesState=value},
get architectureSourcesLoadSeq(){return architectureSourcesLoadSeq},set architectureSourcesLoadSeq(value){architectureSourcesLoadSeq=value},
get sourceHealthFindings(){return sourceHealthFindings},
get sourceHealthSeverity(){return sourceHealthSeverity},
get renderArchitectureSourceHealthSummary(){return renderArchitectureSourceHealthSummary},
get openArchitectureSourceHealthModal(){return openArchitectureSourceHealthModal},
get renderArchitectureSourceList(){return renderArchitectureSourceList},
get renderArchitectureSourceDetail(){return renderArchitectureSourceDetail},
get selectArchitectureSource(){return selectArchitectureSource},
get loadArchitectureSources(){return loadArchitectureSources},mount(){},dispose(){}};},
sql(host){const architectureSqlForm = document.getElementById('architecture-sql-form');
const architectureSqlMetricEl = document.getElementById('architecture-sql-metric');
const architectureSqlDimensionEl = document.getElementById('architecture-sql-dimension');
const architectureSqlFilterColumnEl = document.getElementById('architecture-sql-filter-column');
const architectureSqlFilterValueEl = document.getElementById('architecture-sql-filter-value');
const architectureSqlLimitEl = document.getElementById('architecture-sql-limit');
const architectureSqlPlanBtn = document.getElementById('architecture-sql-plan-btn');
const architectureSqlApproveBtn = document.getElementById('architecture-sql-approve-btn');
const architectureSqlExecuteBtn = document.getElementById('architecture-sql-execute-btn');
const architectureSqlStatusEl = document.getElementById('architecture-sql-status');
const architectureSqlPreviewEl = document.getElementById('architecture-sql-preview');
const architectureSqlResultsEl = document.getElementById('architecture-sql-results');
const architectureSqlValidationForm = document.getElementById('architecture-sql-validation-form');
const architectureSqlValidationInputEl = document.getElementById('architecture-sql-validation-input');
const architectureSqlValidationBtn = document.getElementById('architecture-sql-validation-btn');
const architectureSqlValidationResultEl = document.getElementById('architecture-sql-validation-result');
let architectureSqlState = { plan: null, approvalToken: '', executed: null };
let architectureSqlBusy = '';
let architectureSqlPlanRequest = 0;
let architectureSqlValidationState = null;
function architectureSqlPlanInput(){}
function invalidateArchitectureSqlPlan(){}
function renderArchitectureSqlValidation(){}
function validateArchitectureSql(){}
function renderArchitectureSqlResults(){}
function planArchitectureSql(){}
function approveArchitectureSql(){}
function executeArchitectureSql(){}
return {get architectureSqlForm(){return architectureSqlForm},
get architectureSqlMetricEl(){return architectureSqlMetricEl},
get architectureSqlDimensionEl(){return architectureSqlDimensionEl},
get architectureSqlFilterColumnEl(){return architectureSqlFilterColumnEl},
get architectureSqlFilterValueEl(){return architectureSqlFilterValueEl},
get architectureSqlLimitEl(){return architectureSqlLimitEl},
get architectureSqlPlanBtn(){return architectureSqlPlanBtn},
get architectureSqlApproveBtn(){return architectureSqlApproveBtn},
get architectureSqlExecuteBtn(){return architectureSqlExecuteBtn},
get architectureSqlStatusEl(){return architectureSqlStatusEl},
get architectureSqlPreviewEl(){return architectureSqlPreviewEl},
get architectureSqlResultsEl(){return architectureSqlResultsEl},
get architectureSqlValidationForm(){return architectureSqlValidationForm},
get architectureSqlValidationInputEl(){return architectureSqlValidationInputEl},
get architectureSqlValidationBtn(){return architectureSqlValidationBtn},
get architectureSqlValidationResultEl(){return architectureSqlValidationResultEl},
get architectureSqlState(){return architectureSqlState},set architectureSqlState(value){architectureSqlState=value},
get architectureSqlBusy(){return architectureSqlBusy},set architectureSqlBusy(value){architectureSqlBusy=value},
get architectureSqlPlanRequest(){return architectureSqlPlanRequest},set architectureSqlPlanRequest(value){architectureSqlPlanRequest=value},
get architectureSqlValidationState(){return architectureSqlValidationState},set architectureSqlValidationState(value){architectureSqlValidationState=value},
get architectureSqlPlanInput(){return architectureSqlPlanInput},
get invalidateArchitectureSqlPlan(){return invalidateArchitectureSqlPlan},
get renderArchitectureSqlValidation(){return renderArchitectureSqlValidation},
get validateArchitectureSql(){return validateArchitectureSql},
get renderArchitectureSqlResults(){return renderArchitectureSqlResults},
get planArchitectureSql(){return planArchitectureSql},
get approveArchitectureSql(){return approveArchitectureSql},
get executeArchitectureSql(){return executeArchitectureSql},mount(){},dispose(){}};},
workflows(host){const architectureWorkflowStatusEl = document.getElementById('architecture-workflow-status');
const architectureWorkflowRefreshBtn = document.getElementById('architecture-workflow-refresh');
const architectureApprovalListEl = document.getElementById('architecture-approval-list');
const architectureApprovalDetailEl = document.getElementById('architecture-approval-detail');
const architectureHighRiskWriteModalEl = document.getElementById('architecture-high-risk-write-modal');
const architectureHighRiskWriteContentEl = document.getElementById('architecture-high-risk-write-content');
const architectureHighRiskWriteCloseBtn = document.getElementById('architecture-high-risk-write-close');
const architectureHighRiskWriteRejectBtn = document.getElementById('architecture-high-risk-write-reject');
const architectureHighRiskWriteApproveBtn = document.getElementById('architecture-high-risk-write-approve');
const workflowOpsTabBtns = Array.from(document.querySelectorAll('.workflow-ops-tab'));
const workflowOpsPanelEls = Array.from(document.querySelectorAll('.workflow-ops-view'));
const workflowOpsSummaryBtns = Array.from(document.querySelectorAll('[data-workflow-summary-view]'));
const workflowOpsWorkflowCountEl = document.getElementById('workflow-ops-workflow-count');
const workflowOpsRunCountEl = document.getElementById('workflow-ops-run-count');
const workflowOpsPendingCountEl = document.getElementById('workflow-ops-pending-count');
const workflowOpsAcceptanceRateEl = document.getElementById('workflow-ops-acceptance-rate');
const workflowOpsAcceptanceTrendEl = document.getElementById('workflow-ops-acceptance-trend');
const workflowOpsAttentionEl = document.getElementById('workflow-ops-attention');
const workflowOpsRecentRunsEl = document.getElementById('workflow-ops-recent-runs');
const workflowOpsShadowReadinessEl = document.getElementById('workflow-ops-shadow-readiness');
const workflowOpsCompileForm = document.getElementById('workflow-ops-compile-form');
const workflowOpsCompileNameEl = document.getElementById('workflow-ops-compile-name');
const workflowOpsCompileRiskEl = document.getElementById('workflow-ops-compile-risk');
const workflowOpsCompileTranscriptEl = document.getElementById('workflow-ops-compile-transcript');
const workflowOpsCompileSourcesEl = document.getElementById('workflow-ops-compile-sources');
const workflowOpsCompileToolEl = document.getElementById('workflow-ops-compile-tool');
const workflowOpsCompilePublishEl = document.getElementById('workflow-ops-compile-publish');
const workflowOpsCompileDryRunEl = document.getElementById('workflow-ops-compile-dry-run');
const workflowOpsCompileBtn = document.getElementById('workflow-ops-compile-btn');
const workflowOpsLibrarySearchEl = document.getElementById('workflow-ops-library-search');
const workflowOpsLibraryListEl = document.getElementById('workflow-ops-library-list');
const workflowOpsLibraryDetailEl = document.getElementById('workflow-ops-library-detail');
const workflowOpsRunSearchEl = document.getElementById('workflow-ops-run-search');
const workflowOpsRunStatusEl = document.getElementById('workflow-ops-run-status');
const workflowOpsRunListEl = document.getElementById('workflow-ops-run-list');
const workflowOpsRunDetailEl = document.getElementById('workflow-ops-run-detail');
const workflowOpsShadowListEl = document.getElementById('workflow-ops-shadow-list');
const workflowOpsShadowDetailEl = document.getElementById('workflow-ops-shadow-detail');
let architectureWorkflowState = {
  view: 'overview',
  compilations: [],
  runs: [],
  approvals: [],
  comparisons: [],
  shadowSummary: null,
  selectedCompilation: null,
  selectedRun: null,
  selectedShadowRun: null,
  selected: null,
  inspected: null,
  loaded: false,
};
let architectureWorkflowDecision = '';
let architectureHighRiskWriteContext = null;
let architectureWorkflowBusy = '';
let architectureWorkflowLoadRequest = 0;
let architectureWorkflowRefreshTimer = null;
const WORKFLOW_OPS_REFRESH_MS = 30000;
function workflowOpsWorkspaceQuery(){}
function workflowOpsSplitValues(){}
function workflowOpsAcceptanceText(){}
function workflowOpsAcceptanceTrend(){}
function stopWorkflowOpsAutoRefresh(){}
function scheduleWorkflowOpsAutoRefresh(){}
function activateWorkflowOpsView(){}
function renderWorkflowOpsSummary(){}
function workflowOpsSortedRuns(){}
function renderWorkflowOpsOverview(){}
function workflowOpsFilteredCompilations(){}
function renderWorkflowOpsLibraryList(){}
function renderWorkflowOpsLibraryDetail(){}
function selectWorkflowOpsCompilation(){return Promise.resolve();}
function compileWorkflowOperation(){}
function startWorkflowOpsRun(){}
function workflowOpsFilteredRuns(){}
function renderWorkflowOpsRunList(){}
function workflowOpsDisclosure(){}
function openWorkflowEvidenceSource(){return Promise.resolve();}
function workflowOpsEvidenceLinks(){}
function workflowOpsActionCards(){}
function renderWorkflowOpsRunDetail(){}
function selectWorkflowOpsRun(){return Promise.resolve();}
function workflowOpsComparisonForRun(){}
function workflowOpsShadowRuns(){}
function renderWorkflowOpsShadowList(){}
function renderWorkflowOpsShadowDetail(){}
function selectWorkflowOpsShadowRun(){return Promise.resolve();}
function labelWorkflowOpsShadow(){}
function renderWorkflowOperationsCenter(){}
function renderArchitectureApprovalList(){}
function highRiskWriteDetails(){}
function closeHighRiskWriteModal(){}
function openHighRiskWriteModal(){return Promise.resolve();}
function renderArchitectureApprovalDetail(){}
function selectArchitectureApproval(){return Promise.resolve();}
function loadArchitectureWorkflowApprovals(){return Promise.resolve();}
function decideArchitectureApproval(){}
return {get architectureWorkflowStatusEl(){return architectureWorkflowStatusEl},
get architectureWorkflowRefreshBtn(){return architectureWorkflowRefreshBtn},
get architectureApprovalListEl(){return architectureApprovalListEl},
get architectureApprovalDetailEl(){return architectureApprovalDetailEl},
get architectureHighRiskWriteModalEl(){return architectureHighRiskWriteModalEl},
get architectureHighRiskWriteContentEl(){return architectureHighRiskWriteContentEl},
get architectureHighRiskWriteCloseBtn(){return architectureHighRiskWriteCloseBtn},
get architectureHighRiskWriteRejectBtn(){return architectureHighRiskWriteRejectBtn},
get architectureHighRiskWriteApproveBtn(){return architectureHighRiskWriteApproveBtn},
get workflowOpsTabBtns(){return workflowOpsTabBtns},
get workflowOpsPanelEls(){return workflowOpsPanelEls},
get workflowOpsSummaryBtns(){return workflowOpsSummaryBtns},
get workflowOpsWorkflowCountEl(){return workflowOpsWorkflowCountEl},
get workflowOpsRunCountEl(){return workflowOpsRunCountEl},
get workflowOpsPendingCountEl(){return workflowOpsPendingCountEl},
get workflowOpsAcceptanceRateEl(){return workflowOpsAcceptanceRateEl},
get workflowOpsAcceptanceTrendEl(){return workflowOpsAcceptanceTrendEl},
get workflowOpsAttentionEl(){return workflowOpsAttentionEl},
get workflowOpsRecentRunsEl(){return workflowOpsRecentRunsEl},
get workflowOpsShadowReadinessEl(){return workflowOpsShadowReadinessEl},
get workflowOpsCompileForm(){return workflowOpsCompileForm},
get workflowOpsCompileNameEl(){return workflowOpsCompileNameEl},
get workflowOpsCompileRiskEl(){return workflowOpsCompileRiskEl},
get workflowOpsCompileTranscriptEl(){return workflowOpsCompileTranscriptEl},
get workflowOpsCompileSourcesEl(){return workflowOpsCompileSourcesEl},
get workflowOpsCompileToolEl(){return workflowOpsCompileToolEl},
get workflowOpsCompilePublishEl(){return workflowOpsCompilePublishEl},
get workflowOpsCompileDryRunEl(){return workflowOpsCompileDryRunEl},
get workflowOpsCompileBtn(){return workflowOpsCompileBtn},
get workflowOpsLibrarySearchEl(){return workflowOpsLibrarySearchEl},
get workflowOpsLibraryListEl(){return workflowOpsLibraryListEl},
get workflowOpsLibraryDetailEl(){return workflowOpsLibraryDetailEl},
get workflowOpsRunSearchEl(){return workflowOpsRunSearchEl},
get workflowOpsRunStatusEl(){return workflowOpsRunStatusEl},
get workflowOpsRunListEl(){return workflowOpsRunListEl},
get workflowOpsRunDetailEl(){return workflowOpsRunDetailEl},
get workflowOpsShadowListEl(){return workflowOpsShadowListEl},
get workflowOpsShadowDetailEl(){return workflowOpsShadowDetailEl},
get architectureWorkflowState(){return architectureWorkflowState},set architectureWorkflowState(value){architectureWorkflowState=value},
get architectureWorkflowDecision(){return architectureWorkflowDecision},set architectureWorkflowDecision(value){architectureWorkflowDecision=value},
get architectureHighRiskWriteContext(){return architectureHighRiskWriteContext},set architectureHighRiskWriteContext(value){architectureHighRiskWriteContext=value},
get architectureWorkflowBusy(){return architectureWorkflowBusy},set architectureWorkflowBusy(value){architectureWorkflowBusy=value},
get architectureWorkflowLoadRequest(){return architectureWorkflowLoadRequest},set architectureWorkflowLoadRequest(value){architectureWorkflowLoadRequest=value},
get architectureWorkflowRefreshTimer(){return architectureWorkflowRefreshTimer},set architectureWorkflowRefreshTimer(value){architectureWorkflowRefreshTimer=value},
get WORKFLOW_OPS_REFRESH_MS(){return WORKFLOW_OPS_REFRESH_MS},
get workflowOpsWorkspaceQuery(){return workflowOpsWorkspaceQuery},
get workflowOpsSplitValues(){return workflowOpsSplitValues},
get workflowOpsAcceptanceText(){return workflowOpsAcceptanceText},
get workflowOpsAcceptanceTrend(){return workflowOpsAcceptanceTrend},
get stopWorkflowOpsAutoRefresh(){return stopWorkflowOpsAutoRefresh},
get scheduleWorkflowOpsAutoRefresh(){return scheduleWorkflowOpsAutoRefresh},
get activateWorkflowOpsView(){return activateWorkflowOpsView},
get renderWorkflowOpsSummary(){return renderWorkflowOpsSummary},
get workflowOpsSortedRuns(){return workflowOpsSortedRuns},
get renderWorkflowOpsOverview(){return renderWorkflowOpsOverview},
get workflowOpsFilteredCompilations(){return workflowOpsFilteredCompilations},
get renderWorkflowOpsLibraryList(){return renderWorkflowOpsLibraryList},
get renderWorkflowOpsLibraryDetail(){return renderWorkflowOpsLibraryDetail},
get selectWorkflowOpsCompilation(){return selectWorkflowOpsCompilation},
get compileWorkflowOperation(){return compileWorkflowOperation},
get startWorkflowOpsRun(){return startWorkflowOpsRun},
get workflowOpsFilteredRuns(){return workflowOpsFilteredRuns},
get renderWorkflowOpsRunList(){return renderWorkflowOpsRunList},
get workflowOpsDisclosure(){return workflowOpsDisclosure},
get openWorkflowEvidenceSource(){return openWorkflowEvidenceSource},
get workflowOpsEvidenceLinks(){return workflowOpsEvidenceLinks},
get workflowOpsActionCards(){return workflowOpsActionCards},
get renderWorkflowOpsRunDetail(){return renderWorkflowOpsRunDetail},
get selectWorkflowOpsRun(){return selectWorkflowOpsRun},
get workflowOpsComparisonForRun(){return workflowOpsComparisonForRun},
get workflowOpsShadowRuns(){return workflowOpsShadowRuns},
get renderWorkflowOpsShadowList(){return renderWorkflowOpsShadowList},
get renderWorkflowOpsShadowDetail(){return renderWorkflowOpsShadowDetail},
get selectWorkflowOpsShadowRun(){return selectWorkflowOpsShadowRun},
get labelWorkflowOpsShadow(){return labelWorkflowOpsShadow},
get renderWorkflowOperationsCenter(){return renderWorkflowOperationsCenter},
get renderArchitectureApprovalList(){return renderArchitectureApprovalList},
get highRiskWriteDetails(){return highRiskWriteDetails},
get closeHighRiskWriteModal(){return closeHighRiskWriteModal},
get openHighRiskWriteModal(){return openHighRiskWriteModal},
get renderArchitectureApprovalDetail(){return renderArchitectureApprovalDetail},
get selectArchitectureApproval(){return selectArchitectureApproval},
get loadArchitectureWorkflowApprovals(){return loadArchitectureWorkflowApprovals},
get decideArchitectureApproval(){return decideArchitectureApproval},mount(){},dispose(){}};},
evaluation(host){const architectureEvaluationStatusEl = document.getElementById('architecture-evaluation-status');
const architectureEvaluationRefreshBtn = document.getElementById('architecture-evaluation-refresh');
const evaluationTraceCountEl = document.getElementById('evaluation-trace-count');
const evaluationPassRateEl = document.getElementById('evaluation-pass-rate');
const evaluationCompletionRateEl = document.getElementById('evaluation-completion-rate');
const evaluationNetBenefitEl = document.getElementById('evaluation-net-benefit');
const evaluationTraceListEl = document.getElementById('evaluation-trace-list');
const evaluationTraceDetailEl = document.getElementById('evaluation-trace-detail');
const evaluationSuiteListEl = document.getElementById('evaluation-suite-list');
const evaluationSuiteDetailEl = document.getElementById('evaluation-suite-detail');
const evaluationRoiDetailEl = document.getElementById('evaluation-roi-detail');
let architectureEvaluationState = { metrics: null, roi: null, traces: [], suites: [], runs: [], selectedTrace: null, traceDetail: null, selectedSuite: null, loaded: false };
let architectureEvaluationLoadRequest = 0;
function evaluationPercent(){}
function evaluationMoney(){}
function evaluationDuration(){}
function renderArchitectureEvaluationSummary(){}
function evaluationSortedTraces(){}
function renderArchitectureEvaluationTraceList(){}
function renderArchitectureEvaluationTraceDetail(){}
function selectArchitectureEvaluationTrace(){return Promise.resolve();}
function replayArchitectureEvaluationTrace(){}
function renderArchitectureEvaluationSuiteList(){}
function renderArchitectureEvaluationSuiteDetail(){}
function runArchitectureEvaluationSuite(){return Promise.resolve();}
function renderArchitectureEvaluationRoi(){}
function loadArchitectureEvaluation(){return Promise.resolve();}
return {get architectureEvaluationStatusEl(){return architectureEvaluationStatusEl},
get architectureEvaluationRefreshBtn(){return architectureEvaluationRefreshBtn},
get evaluationTraceCountEl(){return evaluationTraceCountEl},
get evaluationPassRateEl(){return evaluationPassRateEl},
get evaluationCompletionRateEl(){return evaluationCompletionRateEl},
get evaluationNetBenefitEl(){return evaluationNetBenefitEl},
get evaluationTraceListEl(){return evaluationTraceListEl},
get evaluationTraceDetailEl(){return evaluationTraceDetailEl},
get evaluationSuiteListEl(){return evaluationSuiteListEl},
get evaluationSuiteDetailEl(){return evaluationSuiteDetailEl},
get evaluationRoiDetailEl(){return evaluationRoiDetailEl},
get architectureEvaluationState(){return architectureEvaluationState},set architectureEvaluationState(value){architectureEvaluationState=value},
get architectureEvaluationLoadRequest(){return architectureEvaluationLoadRequest},set architectureEvaluationLoadRequest(value){architectureEvaluationLoadRequest=value},
get evaluationPercent(){return evaluationPercent},
get evaluationMoney(){return evaluationMoney},
get evaluationDuration(){return evaluationDuration},
get renderArchitectureEvaluationSummary(){return renderArchitectureEvaluationSummary},
get evaluationSortedTraces(){return evaluationSortedTraces},
get renderArchitectureEvaluationTraceList(){return renderArchitectureEvaluationTraceList},
get renderArchitectureEvaluationTraceDetail(){return renderArchitectureEvaluationTraceDetail},
get selectArchitectureEvaluationTrace(){return selectArchitectureEvaluationTrace},
get replayArchitectureEvaluationTrace(){return replayArchitectureEvaluationTrace},
get renderArchitectureEvaluationSuiteList(){return renderArchitectureEvaluationSuiteList},
get renderArchitectureEvaluationSuiteDetail(){return renderArchitectureEvaluationSuiteDetail},
get runArchitectureEvaluationSuite(){return runArchitectureEvaluationSuite},
get renderArchitectureEvaluationRoi(){return renderArchitectureEvaluationRoi},
get loadArchitectureEvaluation(){return loadArchitectureEvaluation},mount(){},dispose(){}};},
graph(host){const architectureGraphForm = document.getElementById('architecture-graph-form');
const architectureGraphRefreshBtn = document.getElementById('architecture-graph-refresh');
const architectureGraphRetrieveBtn = document.getElementById('architecture-graph-retrieve');
const architectureGraphSearchEl = document.getElementById('architecture-graph-search');
const architectureGraphSourceEl = document.getElementById('architecture-graph-source');
const architectureGraphStatusEl = document.getElementById('architecture-graph-status');
const architectureGraphListEl = document.getElementById('architecture-graph-list');
const architectureGraphDetailEl = document.getElementById('architecture-graph-detail');
let architectureGraphState = { entities: [], relationships: [], retrieve: null, selected: null, loaded: false };
let architectureGraphRetrieveRequest = 0;
function architectureGraphEntities(){}
function architectureGraphRelationships(){}
function renderArchitectureGraphList(){}
function renderArchitectureGraphDetail(){}
function selectArchitectureGraphEntity(){return Promise.resolve();}
function loadArchitectureGraph(){return Promise.resolve();}
function firstRetrievedArchitectureGraphEntity(){}
function retrieveArchitectureGraph(){}
return {get architectureGraphForm(){return architectureGraphForm},
get architectureGraphRefreshBtn(){return architectureGraphRefreshBtn},
get architectureGraphRetrieveBtn(){return architectureGraphRetrieveBtn},
get architectureGraphSearchEl(){return architectureGraphSearchEl},
get architectureGraphSourceEl(){return architectureGraphSourceEl},
get architectureGraphStatusEl(){return architectureGraphStatusEl},
get architectureGraphListEl(){return architectureGraphListEl},
get architectureGraphDetailEl(){return architectureGraphDetailEl},
get architectureGraphState(){return architectureGraphState},set architectureGraphState(value){architectureGraphState=value},
get architectureGraphRetrieveRequest(){return architectureGraphRetrieveRequest},set architectureGraphRetrieveRequest(value){architectureGraphRetrieveRequest=value},
get architectureGraphEntities(){return architectureGraphEntities},
get architectureGraphRelationships(){return architectureGraphRelationships},
get renderArchitectureGraphList(){return renderArchitectureGraphList},
get renderArchitectureGraphDetail(){return renderArchitectureGraphDetail},
get selectArchitectureGraphEntity(){return selectArchitectureGraphEntity},
get loadArchitectureGraph(){return loadArchitectureGraph},
get firstRetrievedArchitectureGraphEntity(){return firstRetrievedArchitectureGraphEntity},
get retrieveArchitectureGraph(){return retrieveArchitectureGraph},mount(){},dispose(){}};},
experts(host){const expertMenuEl       = document.getElementById('expert-menu');
const expertToggleBtn    = document.getElementById('expert-toggle-btn');
const expertPopoverEl    = document.getElementById('expert-popover');
const expertEnabledEl    = document.getElementById('expert-enabled');
const expertAllEl        = document.getElementById('expert-all');
const expertListEl       = document.getElementById('expert-list');
const expertModeEl       = document.getElementById('expert-mode');
const expertSynthesizeEl = document.getElementById('expert-synthesize');
const expertStatusEl     = document.getElementById('expert-status');
const architectureReviewForm = document.getElementById('architecture-review-form');
const architectureReviewModalEl = document.getElementById('architecture-review-modal');
const architectureReviewOpenBtn = document.getElementById('architecture-review-open-btn');
const architectureReviewCloseBtn = document.getElementById('architecture-review-close-btn');
const architectureReviewCancelBtn = document.getElementById('architecture-review-cancel-btn');
const architectureReviewQuestionEl = document.getElementById('architecture-review-question');
const architectureReviewTargetTypeEl = document.getElementById('architecture-review-target-type');
const architectureReviewTargetIdEl = document.getElementById('architecture-review-target-id');
const architectureReviewWorkflowIdEl = document.getElementById('architecture-review-workflow-id');
const architectureReviewRunIdEl = document.getElementById('architecture-review-run-id');
const architectureReviewExpertsEl = document.getElementById('architecture-review-experts');
const architectureReviewRefreshBtn = document.getElementById('architecture-review-refresh');
const architectureReviewCreateBtn = document.getElementById('architecture-review-create-btn');
const architectureReviewStatusEl = document.getElementById('architecture-review-status');
const architectureReviewListEl = document.getElementById('architecture-review-list');
const architectureReviewDetailEl = document.getElementById('architecture-review-detail');
let expertPanelExperts = [];
let expertPanelBusy = false;
let architectureReviewState = { reviews: [], selected: null, loaded: false };
function renderArchitectureReviewList(){}
function renderArchitectureReviewDetail(){}
function selectArchitectureReview(){return Promise.resolve();}
function loadArchitectureReviews(){return Promise.resolve();}
function createArchitectureReview(){return Promise.resolve();}
function setExpertStatus(){}
function updateExpertControlsState(){}
function setExpertPopoverOpen(){}
function loadExperts(){return Promise.resolve();}
function renderExpertPanel(){}
function selectedExpertIds(){return Promise.resolve();}
function syncExpertAllFromChoices(){}
function expertUserSummary(){}
function formatExpertPanelResult(){}
function runExpertPanelFromUi(){return Promise.resolve();}
return {get expertMenuEl(){return expertMenuEl},
get expertToggleBtn(){return expertToggleBtn},
get expertPopoverEl(){return expertPopoverEl},
get expertEnabledEl(){return expertEnabledEl},
get expertAllEl(){return expertAllEl},
get expertListEl(){return expertListEl},
get expertModeEl(){return expertModeEl},
get expertSynthesizeEl(){return expertSynthesizeEl},
get expertStatusEl(){return expertStatusEl},
get architectureReviewForm(){return architectureReviewForm},
get architectureReviewModalEl(){return architectureReviewModalEl},
get architectureReviewOpenBtn(){return architectureReviewOpenBtn},
get architectureReviewCloseBtn(){return architectureReviewCloseBtn},
get architectureReviewCancelBtn(){return architectureReviewCancelBtn},
get architectureReviewQuestionEl(){return architectureReviewQuestionEl},
get architectureReviewTargetTypeEl(){return architectureReviewTargetTypeEl},
get architectureReviewTargetIdEl(){return architectureReviewTargetIdEl},
get architectureReviewWorkflowIdEl(){return architectureReviewWorkflowIdEl},
get architectureReviewRunIdEl(){return architectureReviewRunIdEl},
get architectureReviewExpertsEl(){return architectureReviewExpertsEl},
get architectureReviewRefreshBtn(){return architectureReviewRefreshBtn},
get architectureReviewCreateBtn(){return architectureReviewCreateBtn},
get architectureReviewStatusEl(){return architectureReviewStatusEl},
get architectureReviewListEl(){return architectureReviewListEl},
get architectureReviewDetailEl(){return architectureReviewDetailEl},
get expertPanelExperts(){return expertPanelExperts},set expertPanelExperts(value){expertPanelExperts=value},
get expertPanelBusy(){return expertPanelBusy},set expertPanelBusy(value){expertPanelBusy=value},
get architectureReviewState(){return architectureReviewState},set architectureReviewState(value){architectureReviewState=value},
get renderArchitectureReviewList(){return renderArchitectureReviewList},
get renderArchitectureReviewDetail(){return renderArchitectureReviewDetail},
get selectArchitectureReview(){return selectArchitectureReview},
get loadArchitectureReviews(){return loadArchitectureReviews},
get createArchitectureReview(){return createArchitectureReview},
get setExpertStatus(){return setExpertStatus},
get updateExpertControlsState(){return updateExpertControlsState},
get setExpertPopoverOpen(){return setExpertPopoverOpen},
get loadExperts(){return loadExperts},
get renderExpertPanel(){return renderExpertPanel},
get selectedExpertIds(){return selectedExpertIds},
get syncExpertAllFromChoices(){return syncExpertAllFromChoices},
get expertUserSummary(){return expertUserSummary},
get formatExpertPanelResult(){return formatExpertPanelResult},
get runExpertPanelFromUi(){return runExpertPanelFromUi},mount(){},dispose(){}};},
workspace(host){const workspaceToggleBtn = document.getElementById('workspace-toggle-btn');
const workspacePopoverEl = document.getElementById('workspace-popover');
const workspaceListEl    = document.getElementById('workspace-list');
const workspaceNameEl    = document.getElementById('workspace-name');
const workspaceAvatarEl  = document.getElementById('workspace-avatar');
const workspaceStatusEl  = document.getElementById('workspace-status');
const workspaceNewBtn    = document.getElementById('workspace-new-btn');
const workspaceRenameBtn = document.getElementById('workspace-rename-btn');
const workspaceConfigBtn = document.getElementById('workspace-config-btn');
const workspaceDeleteDialogEl = document.getElementById('workspace-delete-dialog');
const workspaceDeleteMessageEl = document.getElementById('workspace-delete-message');
const workspaceDeleteCancelBtn = document.getElementById('workspace-delete-cancel');
const workspaceDeleteConfirmBtn = document.getElementById('workspace-delete-confirm');
let workspaceState = { active: 'default', workspaces: [] };
let workspaceSwitching = false;
const WORKSPACE_RESTART_TIMEOUT_MS = 120000;
const WORKSPACE_RESTART_STATUS_INTERVAL_MS = 5000;
function setWorkspaceStatus(){}
function setWorkspaceSwitching(){}
function workspaceRestartSleep(){}
function workspaceStateHasActiveId(){}
function isWorkspaceFetchFailure(){}
function waitForWorkspaceRestart(){}
function workspaceInitial(){}
function activeWorkspace(){return {id:'default',name:'Default',active:true};}
function activeWorkspaceId(){return 'default';}
function setWorkspacePopoverOpen(){}
function confirmWorkspaceDelete(){}
function workspaceDeleteErrorMessage(){}
function renderWorkspaces(){}
function loadWorkspaces(){return Promise.resolve();}
return {get workspaceToggleBtn(){return workspaceToggleBtn},
get workspacePopoverEl(){return workspacePopoverEl},
get workspaceListEl(){return workspaceListEl},
get workspaceNameEl(){return workspaceNameEl},
get workspaceAvatarEl(){return workspaceAvatarEl},
get workspaceStatusEl(){return workspaceStatusEl},
get workspaceNewBtn(){return workspaceNewBtn},
get workspaceRenameBtn(){return workspaceRenameBtn},
get workspaceConfigBtn(){return workspaceConfigBtn},
get workspaceDeleteDialogEl(){return workspaceDeleteDialogEl},
get workspaceDeleteMessageEl(){return workspaceDeleteMessageEl},
get workspaceDeleteCancelBtn(){return workspaceDeleteCancelBtn},
get workspaceDeleteConfirmBtn(){return workspaceDeleteConfirmBtn},
get workspaceState(){return workspaceState},set workspaceState(value){workspaceState=value},
get workspaceSwitching(){return workspaceSwitching},set workspaceSwitching(value){workspaceSwitching=value},
get WORKSPACE_RESTART_TIMEOUT_MS(){return WORKSPACE_RESTART_TIMEOUT_MS},
get WORKSPACE_RESTART_STATUS_INTERVAL_MS(){return WORKSPACE_RESTART_STATUS_INTERVAL_MS},
get setWorkspaceStatus(){return setWorkspaceStatus},
get setWorkspaceSwitching(){return setWorkspaceSwitching},
get workspaceRestartSleep(){return workspaceRestartSleep},
get workspaceStateHasActiveId(){return workspaceStateHasActiveId},
get isWorkspaceFetchFailure(){return isWorkspaceFetchFailure},
get waitForWorkspaceRestart(){return waitForWorkspaceRestart},
get workspaceInitial(){return workspaceInitial},
get activeWorkspace(){return activeWorkspace},
get activeWorkspaceId(){return activeWorkspaceId},
get setWorkspacePopoverOpen(){return setWorkspacePopoverOpen},
get confirmWorkspaceDelete(){return confirmWorkspaceDelete},
get workspaceDeleteErrorMessage(){return workspaceDeleteErrorMessage},
get renderWorkspaces(){return renderWorkspaces},
get loadWorkspaces(){return loadWorkspaces},mount(){},dispose(){}};},
rag(host){const workspaceSettingsScreenEl = document.getElementById('workspace-settings-screen');
const workspaceSettingsCancelBtn = document.getElementById('workspace-settings-cancel-btn');
const workspaceContextNameEl = document.getElementById('workspace-context-name');
const workspaceRagPathsEl = document.getElementById('workspace-rag-paths');
const workspaceRagProgressBarEl = document.getElementById('workspace-rag-progress-bar');
const workspaceRagStatusEl = document.getElementById('workspace-rag-status');
const workspaceRagCurrentFileEl = document.getElementById('workspace-rag-current-file');
const workspaceRagSaveBtn = document.getElementById('workspace-rag-save-btn');
let workspaceRagPoll = null;
let workspaceRagConfig = null;
let workspaceRagSavedSnapshot = null;
let workspaceRagSaving = false;
let workspaceRagLoadSeq = 0;
function setWorkspaceSettingsOpen(){}
function setWorkspaceRagStatus(){}
function renderWorkspaceRagStatus(){}
function parseWorkspaceRagPaths(){}
function workspaceRagSnapshotFromConfig(){}
function currentWorkspaceRagFormSnapshot(){}
function workspaceRagSnapshotsEqual(){}
function updateWorkspaceRagSaveState(){}
function activeWorkspaceRagContext(){}
function renderWorkspaceRagConfig(){}
function resetWorkspaceRagConfigForm(){}
function loadWorkspaceRagStatus(){return Promise.resolve();}
function loadWorkspaceRagConfig(){return Promise.resolve();}
function startWorkspaceRagPoll(){}
function stopWorkspaceRagPoll(){}
return {get workspaceSettingsScreenEl(){return workspaceSettingsScreenEl},
get workspaceSettingsCancelBtn(){return workspaceSettingsCancelBtn},
get workspaceContextNameEl(){return workspaceContextNameEl},
get workspaceRagPathsEl(){return workspaceRagPathsEl},
get workspaceRagProgressBarEl(){return workspaceRagProgressBarEl},
get workspaceRagStatusEl(){return workspaceRagStatusEl},
get workspaceRagCurrentFileEl(){return workspaceRagCurrentFileEl},
get workspaceRagSaveBtn(){return workspaceRagSaveBtn},
get workspaceRagPoll(){return workspaceRagPoll},set workspaceRagPoll(value){workspaceRagPoll=value},
get workspaceRagConfig(){return workspaceRagConfig},set workspaceRagConfig(value){workspaceRagConfig=value},
get workspaceRagSavedSnapshot(){return workspaceRagSavedSnapshot},set workspaceRagSavedSnapshot(value){workspaceRagSavedSnapshot=value},
get workspaceRagSaving(){return workspaceRagSaving},set workspaceRagSaving(value){workspaceRagSaving=value},
get workspaceRagLoadSeq(){return workspaceRagLoadSeq},set workspaceRagLoadSeq(value){workspaceRagLoadSeq=value},
get setWorkspaceSettingsOpen(){return setWorkspaceSettingsOpen},
get setWorkspaceRagStatus(){return setWorkspaceRagStatus},
get renderWorkspaceRagStatus(){return renderWorkspaceRagStatus},
get parseWorkspaceRagPaths(){return parseWorkspaceRagPaths},
get workspaceRagSnapshotFromConfig(){return workspaceRagSnapshotFromConfig},
get currentWorkspaceRagFormSnapshot(){return currentWorkspaceRagFormSnapshot},
get workspaceRagSnapshotsEqual(){return workspaceRagSnapshotsEqual},
get updateWorkspaceRagSaveState(){return updateWorkspaceRagSaveState},
get activeWorkspaceRagContext(){return activeWorkspaceRagContext},
get renderWorkspaceRagConfig(){return renderWorkspaceRagConfig},
get resetWorkspaceRagConfigForm(){return resetWorkspaceRagConfigForm},
get loadWorkspaceRagStatus(){return loadWorkspaceRagStatus},
get loadWorkspaceRagConfig(){return loadWorkspaceRagConfig},
get startWorkspaceRagPoll(){return startWorkspaceRagPoll},
get stopWorkspaceRagPoll(){return stopWorkspaceRagPoll},mount(){},dispose(){}};},
memory(host){let memoryBrowserStatusEl = null;
const memoryBrowserOverlay = document.getElementById('memory-browser-overlay');
const memoryBrowserCountEl = document.getElementById('memory-browser-count');
const memoryBrowserRefreshBtn = document.getElementById('memory-browser-refresh');
const memoryBrowserCloseBtn = document.getElementById('memory-browser-close');
const memoryBrowserSearchForm = document.getElementById('memory-browser-search-form');
const memoryBrowserSearchEl = document.getElementById('memory-browser-search');
const memoryBrowserFilterEl = document.getElementById('memory-browser-filter');
const memoryBrowserNewFactEl = document.getElementById('memory-browser-new-fact');
const memoryBrowserAddBtn = document.getElementById('memory-browser-add');
const memoryBrowserPanelStatusEl = document.getElementById('memory-browser-panel-status');
const memoryBrowserListEl = document.getElementById('memory-browser-list');
const memoryBrowserLoadMoreBtn = document.getElementById('memory-browser-load-more');
const memoryBrowserEmptyEl = document.getElementById('memory-browser-empty');
const memoryBrowserDetailForm = document.getElementById('memory-browser-detail-form');
const memoryBrowserStateEl = document.getElementById('memory-browser-state');
const memoryBrowserMemoryTitleEl = document.getElementById('memory-browser-memory-title');
const memoryBrowserFactInput = document.getElementById('memory-browser-fact-input');
const memoryBrowserSessionIdInput = document.getElementById('memory-browser-session-id');
const memoryBrowserMessageIdInput = document.getElementById('memory-browser-message-id');
const memoryBrowserCreatedAtInput = document.getElementById('memory-browser-created-at');
const memoryBrowserVersionInput = document.getElementById('memory-browser-version');
const memoryBrowserDreamSkillInput = document.getElementById('memory-browser-dream-skill');
const memoryBrowserIgnoreUntilInput = document.getElementById('memory-browser-ignore-until');
const memoryBrowserDeleteBtn = document.getElementById('memory-browser-delete');
const memoryBrowserSaveBtn = document.getElementById('memory-browser-save');
let memoryBrowserState = { items: [], cursor: undefined, selected: null, loaded: false };
function setMemoryBrowserLauncherStatus(){}
function setMemoryBrowserPanelStatus(){}
function formatMemoryBrowserDate(){}
function getMemoryBrowserState(){}
function memoryBrowserWhere(){}
function callMemoryBrowserAction(){}
function renderMemoryBrowserCount(){}
function renderMemoryBrowserList(){}
function renderMemoryBrowserDetail(){}
function selectMemoryBrowserMemory(){return Promise.resolve();}
function loadMemoryBrowserMemories(){return Promise.resolve();}
function memoryBrowserSelectedData(){}
function saveMemoryBrowserSelection(){return Promise.resolve();}
function deleteMemoryBrowserSelection(){return Promise.resolve();}
function addMemoryBrowserMemory(){}
function openMemoryBrowser(){return Promise.resolve();}
function closeMemoryBrowser(){}
function appendMemoryBrowserLauncher(){}
return {get memoryBrowserStatusEl(){return memoryBrowserStatusEl},set memoryBrowserStatusEl(value){memoryBrowserStatusEl=value},
get memoryBrowserOverlay(){return memoryBrowserOverlay},
get memoryBrowserCountEl(){return memoryBrowserCountEl},
get memoryBrowserRefreshBtn(){return memoryBrowserRefreshBtn},
get memoryBrowserCloseBtn(){return memoryBrowserCloseBtn},
get memoryBrowserSearchForm(){return memoryBrowserSearchForm},
get memoryBrowserSearchEl(){return memoryBrowserSearchEl},
get memoryBrowserFilterEl(){return memoryBrowserFilterEl},
get memoryBrowserNewFactEl(){return memoryBrowserNewFactEl},
get memoryBrowserAddBtn(){return memoryBrowserAddBtn},
get memoryBrowserPanelStatusEl(){return memoryBrowserPanelStatusEl},
get memoryBrowserListEl(){return memoryBrowserListEl},
get memoryBrowserLoadMoreBtn(){return memoryBrowserLoadMoreBtn},
get memoryBrowserEmptyEl(){return memoryBrowserEmptyEl},
get memoryBrowserDetailForm(){return memoryBrowserDetailForm},
get memoryBrowserStateEl(){return memoryBrowserStateEl},
get memoryBrowserMemoryTitleEl(){return memoryBrowserMemoryTitleEl},
get memoryBrowserFactInput(){return memoryBrowserFactInput},
get memoryBrowserSessionIdInput(){return memoryBrowserSessionIdInput},
get memoryBrowserMessageIdInput(){return memoryBrowserMessageIdInput},
get memoryBrowserCreatedAtInput(){return memoryBrowserCreatedAtInput},
get memoryBrowserVersionInput(){return memoryBrowserVersionInput},
get memoryBrowserDreamSkillInput(){return memoryBrowserDreamSkillInput},
get memoryBrowserIgnoreUntilInput(){return memoryBrowserIgnoreUntilInput},
get memoryBrowserDeleteBtn(){return memoryBrowserDeleteBtn},
get memoryBrowserSaveBtn(){return memoryBrowserSaveBtn},
get memoryBrowserState(){return memoryBrowserState},set memoryBrowserState(value){memoryBrowserState=value},
get setMemoryBrowserLauncherStatus(){return setMemoryBrowserLauncherStatus},
get setMemoryBrowserPanelStatus(){return setMemoryBrowserPanelStatus},
get formatMemoryBrowserDate(){return formatMemoryBrowserDate},
get getMemoryBrowserState(){return getMemoryBrowserState},
get memoryBrowserWhere(){return memoryBrowserWhere},
get callMemoryBrowserAction(){return callMemoryBrowserAction},
get renderMemoryBrowserCount(){return renderMemoryBrowserCount},
get renderMemoryBrowserList(){return renderMemoryBrowserList},
get renderMemoryBrowserDetail(){return renderMemoryBrowserDetail},
get selectMemoryBrowserMemory(){return selectMemoryBrowserMemory},
get loadMemoryBrowserMemories(){return loadMemoryBrowserMemories},
get memoryBrowserSelectedData(){return memoryBrowserSelectedData},
get saveMemoryBrowserSelection(){return saveMemoryBrowserSelection},
get deleteMemoryBrowserSelection(){return deleteMemoryBrowserSelection},
get addMemoryBrowserMemory(){return addMemoryBrowserMemory},
get openMemoryBrowser(){return openMemoryBrowser},
get closeMemoryBrowser(){return closeMemoryBrowser},
get appendMemoryBrowserLauncher(){return appendMemoryBrowserLauncher},mount(){},dispose(){}};},
files(host){const updatedFiles   = new Set();
const selectedWorkspaceFiles = new Map();
const knownWorkspaceFiles = new Set();
let selectedWorkspaceOwner = null;
const attachmentTrayEl = document.getElementById('attachment-tray');
const filesSectionEl = document.querySelector('[data-section="files"]');
function formatSize(){}
function syncWorkspaceFileAttachmentRows(){}
function renderAttachmentTray(){}
function setWorkspaceFileAttached(){}
function clearWorkspaceFileAttachments(){}
function reconcileWorkspaceFileAttachments(){}
function renderFiles(){}
function loadFiles(){return Promise.resolve();}
function uploadFiles(){}
return {get updatedFiles(){return updatedFiles},
get selectedWorkspaceFiles(){return selectedWorkspaceFiles},
get knownWorkspaceFiles(){return knownWorkspaceFiles},
get selectedWorkspaceOwner(){return selectedWorkspaceOwner},set selectedWorkspaceOwner(value){selectedWorkspaceOwner=value},
get attachmentTrayEl(){return attachmentTrayEl},
get formatSize(){return formatSize},
get syncWorkspaceFileAttachmentRows(){return syncWorkspaceFileAttachmentRows},
get renderAttachmentTray(){return renderAttachmentTray},
get setWorkspaceFileAttached(){return setWorkspaceFileAttached},
get clearWorkspaceFileAttachments(){return clearWorkspaceFileAttachments},
get reconcileWorkspaceFileAttachments(){return reconcileWorkspaceFileAttachments},
get renderFiles(){return renderFiles},
get loadFiles(){return loadFiles},
get uploadFiles(){return uploadFiles},
get filesSectionEl(){return filesSectionEl},mount(){},dispose(){}};},
runtime(host){const LS_PROVIDER       = 'provider';
let providerDiscoveryFailed = false;
const providerSel    = document.getElementById('provider-select');
const architectureOpenPluginManagementBtn = document.getElementById('architecture-open-plugin-management');
const HOST_RUNTIME = host.T.hostRuntime || 'node';
const CORE_PLUGIN_NAMES = new Set([
  '@matatbread/matbot-sessions',
  '@matatbread/matbot-tool-workspace',
  '@matatbread/matbot-workflow-governance',
  '@matatbread/matbot-frontend',
]);
const corePluginRemovalDialogEl = document.getElementById('core-plugin-removal-dialog');
const corePluginRemovalMessageEl = document.getElementById('core-plugin-removal-message');
const corePluginRemovalCloseBtn = document.getElementById('core-plugin-removal-close');
const corePluginRemovalCancelBtn = document.getElementById('core-plugin-removal-cancel');
function providerStorageKey(){}
function savedProviderForWorkspace(){return Promise.resolve();}
function apiListProviders(){return Promise.resolve([]);}
function refreshProviderSelect(){}
function makePluginLabel(){}
function loadPlugins(){return Promise.resolve();}
function closeCorePluginRemovalDialog(){}
function openCorePluginRemovalDialog(){return Promise.resolve();}
function runsHere(){return Promise.resolve();}
function renderPlugins(){}
return {get LS_PROVIDER(){return LS_PROVIDER},
get providerStorageKey(){return providerStorageKey},
get savedProviderForWorkspace(){return savedProviderForWorkspace},
get providerDiscoveryFailed(){return providerDiscoveryFailed},set providerDiscoveryFailed(value){providerDiscoveryFailed=value},
get providerSel(){return providerSel},
get architectureOpenPluginManagementBtn(){return architectureOpenPluginManagementBtn},
get apiListProviders(){return apiListProviders},
get refreshProviderSelect(){return refreshProviderSelect},
get makePluginLabel(){return makePluginLabel},
get loadPlugins(){return loadPlugins},
get HOST_RUNTIME(){return HOST_RUNTIME},
get CORE_PLUGIN_NAMES(){return CORE_PLUGIN_NAMES},
get corePluginRemovalDialogEl(){return corePluginRemovalDialogEl},
get corePluginRemovalMessageEl(){return corePluginRemovalMessageEl},
get corePluginRemovalCloseBtn(){return corePluginRemovalCloseBtn},
get corePluginRemovalCancelBtn(){return corePluginRemovalCancelBtn},
get closeCorePluginRemovalDialog(){return closeCorePluginRemovalDialog},
get openCorePluginRemovalDialog(){return openCorePluginRemovalDialog},
get runsHere(){return runsHere},
get renderPlugins(){return renderPlugins},mount(){},dispose(){}};},
skills(host){const skillEditorOverlay = document.getElementById('skill-editor-overlay');
const skillEditorText    = document.getElementById('skill-editor-text');
const skillEditorTitle   = document.getElementById('skill-editor-title');
const skillEditorError   = document.getElementById('skill-editor-error');
const skillEditorSave    = document.getElementById('skill-editor-save');
const skillEditorRoot    = document.getElementById('skill-editor');
const skillTriggerList   = document.getElementById('skill-trigger-list');
const skillTriggerDialog = document.getElementById('skill-trigger-dialog');
const skillTriggerDialogKind = document.getElementById('skill-trigger-dialog-kind');
const skillTriggerDialogRule = document.getElementById('skill-trigger-dialog-rule');
const skillTriggerDialogAction = document.getElementById('skill-trigger-dialog-action');
const skillTriggerDialogError = document.getElementById('skill-trigger-dialog-error');
const TRIGGER_KINDS = ['ephemeral', 'contextual', 'retract', 'followup'];
let editingSkillName = null;
let skillEditor = null;
let editingSkillSavedContent = '';
let editingTriggerId = null;
function loadSkills(){return Promise.resolve();}
function renderSkills(){}
function setSkillTab(){}
function renderSkillMetadata(){}
function makeTriggerRow(){}
function renderTriggers(){}
function saveTriggers(){return Promise.resolve();}
function ensureSkillEditor(){}
function openSkillEditor(){return Promise.resolve();}
function closeSkillEditor(){}
return {get loadSkills(){return loadSkills},
get renderSkills(){return renderSkills},
get skillEditorOverlay(){return skillEditorOverlay},
get skillEditorText(){return skillEditorText},
get skillEditorTitle(){return skillEditorTitle},
get skillEditorError(){return skillEditorError},
get skillEditorSave(){return skillEditorSave},
get skillEditorRoot(){return skillEditorRoot},
get skillTriggerList(){return skillTriggerList},
get skillTriggerDialog(){return skillTriggerDialog},
get skillTriggerDialogKind(){return skillTriggerDialogKind},
get skillTriggerDialogRule(){return skillTriggerDialogRule},
get skillTriggerDialogAction(){return skillTriggerDialogAction},
get skillTriggerDialogError(){return skillTriggerDialogError},
get TRIGGER_KINDS(){return TRIGGER_KINDS},
get editingSkillName(){return editingSkillName},set editingSkillName(value){editingSkillName=value},
get skillEditor(){return skillEditor},set skillEditor(value){skillEditor=value},
get editingSkillSavedContent(){return editingSkillSavedContent},set editingSkillSavedContent(value){editingSkillSavedContent=value},
get editingTriggerId(){return editingTriggerId},set editingTriggerId(value){editingTriggerId=value},
get setSkillTab(){return setSkillTab},
get renderSkillMetadata(){return renderSkillMetadata},
get makeTriggerRow(){return makeTriggerRow},
get renderTriggers(){return renderTriggers},
get saveTriggers(){return saveTriggers},
get ensureSkillEditor(){return ensureSkillEditor},
get openSkillEditor(){return openSkillEditor},
get closeSkillEditor(){return closeSkillEditor},mount(){},dispose(){}};}};

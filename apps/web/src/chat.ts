import {
  AnalysisPlanSchema,
  InsightReportSchema,
  PlanStepSchema,
  RootCauseAnswerSchema,
  SQLAnswerSchema,
  SQLAnswerStatusSchema,
  TimePeriodSchema,
  type AnalysisPlan,
  type InsightReport,
  type PlanStep,
  type RootCauseAnswer,
  type SQLAnswer,
  type SseProgressEvent,
  type TimePeriod,
} from "@shared/contracts";

export type Phase = "idle" | "streaming" | "waiting" | "completed" | "failed";
export interface Clarification { question: string; options: string[] }

export interface PlanReviewState {
  action: "review_analysis_plan";
  plan: AnalysisPlan;
  asOf?: string;
  checkpointId?: string;
  reason?: string;
}

export interface ChatRootCauseState {
  answer: RootCauseAnswer | null;
  plan: AnalysisPlan | null;
  steps: PlanStep[];
  status: SQLAnswer["status"];
  falsePremise: boolean;
  message?: string;
  metricName?: string;
  baselineVal?: number;
  currentVal?: number;
  absDelta?: number;
  pctDelta?: number;
  baselinePeriod?: TimePeriod;
  currentPeriod?: TimePeriod;
  sql?: string | null;
}

export interface ChatVizState {
  title: string;
  report: InsightReport;
  openuiLang: string;
  truncated: boolean;
  narrativeDowngraded?: boolean;
  resultPreview?: Record<string, unknown>[];
}

export interface ChatState {
  phase: Phase;
  runId: string | null;
  threadId: string | null;
  checkpointId: string | null;
  events: SseProgressEvent[];
  clarification: Clarification | null;
  planReview: PlanReviewState | null;
  rootCause: ChatRootCauseState | null;
  answer: string | null;
  answerDetail: SQLAnswer | null;
  viz: ChatVizState | null;
  error: string | null;
  conflictError: string | null;
}

export const initialChat: ChatState = {
  phase: "idle",
  runId: null,
  threadId: null,
  checkpointId: null,
  events: [],
  clarification: null,
  planReview: null,
  rootCause: null,
  answer: null,
  answerDetail: null,
  viz: null,
  error: null,
  conflictError: null,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function extractVizPayload(
  value: unknown,
  fallbackTitle = "Kết quả phân tích",
): ChatVizState | null {
  const data = record(value);
  if (!data) return null;
  const vizSpec = record(data.vizSpec);
  const rawReport =
    data.report ??
    vizSpec?.report ??
    (data.kind === "insight_report" ? data.data : undefined) ??
    data.insightReport ??
    data;
  const parsed = InsightReportSchema.safeParse(rawReport);
  if (!parsed.success) return null;

  const rawLang =
    data.openuiLang ?? data.lang ?? vizSpec?.openuiLang ?? vizSpec?.lang;
  const openuiLang = typeof rawLang === "string" ? rawLang : "";

  const titleCandidates = [
    data.title,
    vizSpec?.title,
    data.question,
    data.summary,
    fallbackTitle,
  ];
  const title =
    titleCandidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    )?.trim() ?? fallbackTitle;

  const answerRecord = record(data.answer);
  const truncated = Boolean(
    data.truncated ??
      data.resultTruncated ??
      vizSpec?.truncated ??
      vizSpec?.resultTruncated ??
      answerRecord?.resultTruncated ??
      false,
  );

  const rawDowngraded =
    data.narrativeDowngraded ?? vizSpec?.narrativeDowngraded;
  const narrativeDowngraded =
    typeof rawDowngraded === "boolean" ? rawDowngraded : undefined;

  const rawPreview = Array.isArray(data.resultPreview)
    ? data.resultPreview
    : Array.isArray(answerRecord?.resultPreview)
      ? answerRecord.resultPreview
      : Array.isArray(vizSpec?.resultPreview)
        ? vizSpec.resultPreview
        : undefined;
  const resultPreview = rawPreview
    ?.filter((row): row is Record<string, unknown> => record(row) !== null)
    .slice(0, 50);

  return {
    title,
    report: parsed.data,
    openuiLang,
    truncated,
    ...(narrativeDowngraded !== undefined ? { narrativeDowngraded } : {}),
    ...(resultPreview ? { resultPreview } : {}),
  };
}

export function clarificationFrom(value: unknown): Clarification | null {
  const payload = record(value);
  const pending = payload?.pendingClarification;
  const structured = record(pending);
  const options = Array.isArray(pending) ? pending : structured?.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 4 ||
    !options.every((option): option is string => typeof option === "string" && option.trim().length > 0)) return null;
  const question = structured?.question ?? payload?.reason;
  return { question: typeof question === "string" && question.trim() ? question : "Vui lòng chọn một phương án để tiếp tục.", options };
}

export function planReviewFrom(value: unknown): PlanReviewState | null {
  const payload = record(value);
  if (!payload) return null;
  if (typeof payload.action === "string" && payload.action !== "review_analysis_plan") {
    return null;
  }
  const rawPlan =
    payload.currentPlan ??
    payload.plan ??
    payload.analysisPlan ??
    (payload.kind === "analysis_plan" ? payload.data : undefined);
  if (payload.action !== "review_analysis_plan" && rawPlan === undefined) {
    return null;
  }
  const parsed = AnalysisPlanSchema.safeParse(rawPlan);
  if (!parsed.success) return null;

  const rawPlanRecord = record(rawPlan);
  const asOf =
    typeof payload.asOf === "string" && payload.asOf.trim().length > 0
      ? payload.asOf
      : typeof rawPlanRecord?.asOf === "string" && rawPlanRecord.asOf.trim().length > 0
        ? rawPlanRecord.asOf
        : undefined;
  const checkpointId =
    typeof payload.checkpointId === "string" && payload.checkpointId.trim().length > 0
      ? payload.checkpointId
      : typeof rawPlanRecord?.checkpointId === "string" && rawPlanRecord.checkpointId.trim().length > 0
        ? rawPlanRecord.checkpointId
        : undefined;
  const reason =
    typeof payload.reason === "string" && payload.reason.trim().length > 0
      ? payload.reason
      : undefined;

  return {
    action: "review_analysis_plan",
    plan: parsed.data,
    ...(asOf ? { asOf } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTimePeriod(value: unknown): TimePeriod | undefined {
  const parsed = TimePeriodSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function extractRootCausePayload(
  value: unknown,
  fallbackPlan?: AnalysisPlan | null,
): ChatRootCauseState | null {
  const data = record(value);
  if (!data) return null;

  const answerRecord = record(data.answer);
  const rawPlan =
    data.analysisPlan ??
    data.plan ??
    data.currentPlan ??
    (data.kind === "analysis_plan" ? data.data : undefined) ??
    answerRecord?.analysisPlan ??
    answerRecord?.plan;
  const parsedPlan = AnalysisPlanSchema.safeParse(rawPlan);
  const plan = parsedPlan.success ? parsedPlan.data : (fallbackPlan ?? null);

  const rawRca =
    data.rootCauseAnswer ??
    data.rootCause ??
    (data.kind === "root_cause" ? data.data : undefined) ??
    (answerRecord?.kind === "root_cause" ? answerRecord.data : undefined) ??
    answerRecord?.rootCauseAnswer ??
    data;
  const parsedRca = RootCauseAnswerSchema.safeParse(rawRca);
  const rca = parsedRca.success ? parsedRca.data : null;

  const rcaRecord = record(rawRca);
  const rawSteps = Array.isArray(data.steps)
    ? data.steps
    : Array.isArray(rcaRecord?.steps)
      ? (rcaRecord.steps as unknown[])
      : Array.isArray(answerRecord?.steps)
        ? (answerRecord.steps as unknown[])
        : undefined;
  const steps = rawSteps
    ? rawSteps
        .map((item) => PlanStepSchema.safeParse(item))
        .filter((item): item is { success: true; data: PlanStep } => item.success)
        .map((item) => item.data)
    : (plan?.steps ?? []);

  const parsedStatus = SQLAnswerStatusSchema.safeParse(
    data.status ?? answerRecord?.status,
  );
  const preliminaryFalsePremise =
    (parsedStatus.success && parsedStatus.data === "false_premise") ||
    data.falsePremise === true ||
    (plan !== null && plan.isValidBaseline === false);

  const status: SQLAnswer["status"] = parsedStatus.success
    ? parsedStatus.data
    : preliminaryFalsePremise
      ? "false_premise"
      : "ok";

  const falsePremise = status === "false_premise" || preliminaryFalsePremise;

  if (!rca && !falsePremise) {
    return null;
  }

  const messageCandidates = [
    data.answerText,
    answerRecord?.answerText,
    data.summary,
    data.message,
    rca?.finalReportMarkdown,
  ];
  const message = messageCandidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );

  const metricNameCandidates = [
    rca?.metricName,
    typeof data.metricName === "string" ? data.metricName : undefined,
    typeof answerRecord?.metricName === "string" ? answerRecord.metricName : undefined,
    plan?.metricName,
  ];
  const metricName = metricNameCandidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );

  const baselineVal =
    rca?.baselineVal ?? finiteNumber(data.baselineVal) ?? plan?.baselineVal;
  const currentVal =
    rca?.currentVal ?? finiteNumber(data.currentVal) ?? plan?.currentVal;
  const absDelta =
    rca?.absDelta ?? finiteNumber(data.absDelta) ?? plan?.absDelta;
  const pctDelta =
    rca?.pctDelta ?? finiteNumber(data.pctDelta) ?? plan?.pctDelta;

  const baselinePeriod =
    rca?.baselinePeriod ??
    parseTimePeriod(data.baselinePeriod) ??
    plan?.baselinePeriod;
  const currentPeriod =
    rca?.currentPeriod ??
    parseTimePeriod(data.currentPeriod) ??
    plan?.currentPeriod;

  const sql =
    typeof data.sql === "string"
      ? data.sql
      : typeof answerRecord?.sql === "string"
        ? answerRecord.sql
        : rca?.primaryCauses.find((cause) => typeof cause.sql === "string" && cause.sql.length > 0)?.sql ?? null;

  return {
    answer: rca,
    plan,
    steps,
    status,
    falsePremise,
    ...(message !== undefined ? { message } : {}),
    ...(metricName !== undefined ? { metricName } : {}),
    ...(baselineVal !== undefined ? { baselineVal } : {}),
    ...(currentVal !== undefined ? { currentVal } : {}),
    ...(absDelta !== undefined ? { absDelta } : {}),
    ...(pctDelta !== undefined ? { pctDelta } : {}),
    ...(baselinePeriod !== undefined ? { baselinePeriod } : {}),
    ...(currentPeriod !== undefined ? { currentPeriod } : {}),
    ...(sql !== null ? { sql } : {}),
  };
}

export type ChatAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "conflict"; message: string }
  | { type: "event"; event: SseProgressEvent }
  | { type: "error"; message: string }
  | { type: "reset" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "start": return { ...initialChat, phase: "streaming" };
    case "resume": return { ...state, phase: "streaming", error: null, conflictError: null };
    case "conflict":
      return {
        ...state,
        phase: state.planReview || state.clarification ? "waiting" : "failed",
        conflictError: action.message,
        error: action.message,
      };
    case "reset": return initialChat;
    case "error": return { ...state, phase: "failed", error: action.message };
    case "event": {
      const event = action.event;
      if ((state.runId && state.runId !== event.runId) || (state.threadId && state.threadId !== event.threadId)) {
        return { ...state, phase: "failed", error: "Mã phiên phản hồi không khớp." };
      }
      const next = { ...state, runId: event.runId, threadId: event.threadId, events: [...state.events, event] };
      const data = record(event.data);
      if (event.event === "interrupt_waiting") {
        const rawCheckpointId =
          typeof (event as { checkpointId?: unknown }).checkpointId === "string" &&
          (event as { checkpointId: string }).checkpointId.trim().length > 0
            ? (event as { checkpointId: string }).checkpointId
            : typeof data?.checkpointId === "string" && data.checkpointId.trim().length > 0
              ? data.checkpointId
              : null;
        const planReviewBase = planReviewFrom(event.data);
        const planReview = planReviewBase
          ? {
              ...planReviewBase,
              ...(rawCheckpointId && !planReviewBase.checkpointId
                ? { checkpointId: rawCheckpointId }
                : {}),
            }
          : null;
        if (planReview) {
          return {
            ...next,
            checkpointId: planReview.checkpointId ?? rawCheckpointId,
            phase: "waiting",
            planReview,
            clarification: null,
            error: null,
            conflictError: null,
          };
        }
        if (data?.action === "review_analysis_plan") {
          return {
            ...next,
            phase: "failed",
            error: "Không nhận được kế hoạch phân tích hợp lệ.",
          };
        }
        const clarification = clarificationFrom(event.data);
        return clarification
          ? {
              ...next,
              checkpointId: rawCheckpointId,
              phase: "waiting",
              clarification,
              planReview: null,
              error: null,
              conflictError: null,
            }
          : { ...next, phase: "failed", error: "Không nhận được lựa chọn làm rõ hợp lệ." };
      }
      if (event.event === "failed") return { ...next, phase: "failed", error: typeof data?.message === "string" ? data.message : "Yêu cầu thất bại." };
      if (event.event === "viz") {
        const viz = extractVizPayload(event.data, state.viz?.title);
        return viz ? { ...next, viz } : next;
      }
      if (event.event === "completed") {
        const answer = SQLAnswerSchema.safeParse(data?.answer ?? event.data);
        const rootCause = extractRootCausePayload(event.data, state.planReview?.plan);
        const extractedViz = extractVizPayload(event.data, state.viz?.title);
        let incomingViz = extractedViz ?? state.viz;
        if (
          incomingViz &&
          extractedViz &&
          !extractedViz.openuiLang &&
          state.viz?.openuiLang
        ) {
          incomingViz = { ...incomingViz, openuiLang: state.viz.openuiLang };
        }
        if (
          incomingViz &&
          !incomingViz.resultPreview &&
          state.viz?.resultPreview
        ) {
          incomingViz = { ...incomingViz, resultPreview: state.viz.resultPreview };
        }
        if (
          incomingViz &&
          answer.success &&
          (!incomingViz.resultPreview || incomingViz.resultPreview.length === 0) &&
          answer.data.resultPreview.length > 0
        ) {
          incomingViz = { ...incomingViz, resultPreview: answer.data.resultPreview };
        }
        return {
          ...next,
          phase: "completed",
          checkpointId: null,
          clarification: null,
          planReview: null,
          conflictError: null,
          rootCause,
          answer: answer.success
            ? answer.data.answerText
            : typeof data?.answerText === "string"
              ? data.answerText
              : typeof data?.summary === "string"
                ? data.summary
                : rootCause?.answer?.finalReportMarkdown ??
                  rootCause?.message ??
                  "Không có nội dung trả lời.",
          answerDetail: answer.success ? answer.data : null,
          viz: incomingViz,
        };
      }
      return next;
    }
  }
}

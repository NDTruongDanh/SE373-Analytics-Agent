import {
  dispatchAlert,
  type AlertDispatcherOptions,
  type AlertHistoryStore,
  type SendAlertTransport,
} from "./dispatcher.js";
import {
  SendAlertInputSchema,
  SendAlertOutputSchema,
  type AnomalyAlert,
  type SendAlertInput,
  type SendAlertOutput,
} from "@shared/contracts";

export interface SendAlertToolOptions {
  historyStore: AlertHistoryStore;
  transport?: SendAlertTransport;
  allowlist?: string[];
  maxRetries?: number;
  timeoutMs?: number;
  initialDelayMs?: number;
  queueFilePath?: string;
  flushDigest?: boolean;
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
}

export async function sendAlert(
  input: SendAlertInput,
  options: SendAlertToolOptions,
): Promise<SendAlertOutput> {
  const validatedInput = SendAlertInputSchema.parse(input);

  const anomalyAlert: AnomalyAlert = {
    metric: validatedInput.metric,
    currentValue: validatedInput.currentValue,
    expectedValue: validatedInput.expectedValue,
    deviation: validatedInput.deviation,
    drilldownSegment: validatedInput.drilldownSegment,
    evidenceSql: validatedInput.evidenceSql,
    recipientId: validatedInput.recipientId,
    recipientRole: validatedInput.recipientRole,
    severity: validatedInput.severity,
    message: validatedInput.message,
  };

  const dispatcherOptions: AlertDispatcherOptions = {
    historyStore: options.historyStore,
    transport: options.transport,
    allowlist: options.allowlist,
    maxRetries: options.maxRetries,
    timeoutMs: options.timeoutMs,
    initialDelayMs: options.initialDelayMs,
    queueFilePath: options.queueFilePath,
    flushDigest: options.flushDigest,
    logger: options.logger,
  };

  const dispatchResult = await dispatchAlert(anomalyAlert, dispatcherOptions);

  const output: SendAlertOutput = {
    sent: dispatchResult.sent,
    fingerprint: dispatchResult.fingerprint,
    queued: dispatchResult.queued,
  };

  return SendAlertOutputSchema.parse(output);
}

import { readFileSync } from "node:fs";
import type { AgentState } from "@shared/agent";

// Allowlisted protocol verdict tokens safe to record verbatim; never user content.
const APPROVAL_VERDICTS = new Set([
  "approve",
  "approved",
  "yes",
  "confirm",
  "accept",
  "proceed",
  "reject",
  "rejected",
  "no",
  "deny",
  "cancel",
]);

export function interruptedOf(output: unknown): unknown[] | undefined {
  return (output as { __interrupt__?: unknown[] }).__interrupt__;
}

export function pendingClarificationOf(output: unknown): AgentState["pendingClarification"] {
  const direct = (output as Partial<AgentState>).pendingClarification;
  if (direct) return direct;
  for (const item of interruptedOf(output) ?? []) {
    const value = (item as { value?: unknown }).value ?? item;
    const pending = (value as { pendingClarification?: unknown }).pendingClarification;
    if (
      pending !== null &&
      typeof pending === "object" &&
      Array.isArray((pending as { options?: unknown }).options)
    ) {
      return pending as AgentState["pendingClarification"];
    }
  }
  return null;
}

export function approvalKindFor(
  out: AgentState,
  pendingClarification: AgentState["pendingClarification"] = out.pendingClarification,
): string {
  return pendingClarification ? "clarification" : "approval";
}

// Record allowlisted protocol tokens verbatim and redact everything else to "provided" + length;
// avoid hashing short inputs because unsalted SHA-256 is brute-forceable.
export function approvalDecision(value: unknown): {
  decision: string;
  valueLength: number;
} {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const lowered = typeof value === "string" ? value.toLowerCase() : "";
  return {
    decision: APPROVAL_VERDICTS.has(lowered) ? lowered : "provided",
    valueLength: text.length,
  };
}

// Scan the run trace for the latest approval_requested since header-only rehydration skips later events.
export function readLastApprovalRequest(
  tracesDir: string,
  runId: string,
): { kind: string; tsMs: number } | null {
  if (runId.includes("/") || runId.includes("\\") || runId.includes("..")) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(`${tracesDir}/${runId}.jsonl`, "utf8");
  } catch {
    return null;
  }
  let last: { kind: string; tsMs: number } | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "approval_requested"
    ) {
      const record = parsed as { ts?: unknown; payload?: unknown };
      const ts = typeof record.ts === "string" ? Date.parse(record.ts) : NaN;
      if (!Number.isFinite(ts)) continue;
      const kind = (record.payload as { kind?: unknown } | null | undefined)
        ?.kind;
      last = {
        kind: typeof kind === "string" && kind.length > 0 ? kind : "approval",
        tsMs: ts,
      };
    }
  }
  return last;
}

export interface ExtractedInterruptInfo {
  pendingClarification: AgentState["pendingClarification"];
  asOf: string | undefined;
  reason: string | undefined;
  action: string | undefined;
  plan: unknown;
  currentPlan: unknown;
}

export function extractInterruptInfo(
  interrupts: unknown[],
  out: AgentState,
): ExtractedInterruptInfo {
  const pendingClarification = pendingClarificationOf(out);
  const rawInterrupt = interrupts[0] as { value?: unknown } | unknown;
  const interruptValue =
    rawInterrupt && typeof rawInterrupt === "object" && "value" in rawInterrupt
      ? (rawInterrupt as { value: unknown }).value
      : rawInterrupt;
  const interruptData =
    interruptValue && typeof interruptValue === "object"
      ? (interruptValue as Record<string, unknown>)
      : {};
  const asOf =
    typeof interruptData["asOf"] === "string"
      ? interruptData["asOf"]
      : out.analysisPlan?.asOf;
  const reason =
    typeof interruptData["reason"] === "string"
      ? interruptData["reason"]
      : undefined;
  const action =
    typeof interruptData["action"] === "string"
      ? interruptData["action"]
      : undefined;
  return {
    pendingClarification,
    asOf,
    reason,
    action,
    plan: interruptData["plan"],
    currentPlan: interruptData["currentPlan"],
  };
}

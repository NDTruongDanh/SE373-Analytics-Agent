// pnpm trace:show <runId> [--json] — G4 trace viewer (03-04).
// Reads only already-redacted files (traces/<runId>.jsonl plus
// logs/mcp_audit.jsonl), performs no DB or network I/O, and passes values
// through without transformation (T-03-11). The tree model comes from the
// shared @shared/agent/telemetry builder so future web code reuses it.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildTraceTree } from "@shared/agent/telemetry";
import type {
  TraceTree,
  TreeAuditLine,
  TreeNode,
} from "@shared/agent/telemetry";

function fail(message: string): never {
  console.error(`[trace:show] ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  runId: string;
  json: boolean;
  tracesDir: string;
  auditPath: string;
} {
  let runId = "";
  let json = false;
  let tracesDir = "traces";
  let auditPath = path.join("logs", "mcp_audit.jsonl");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--traces-dir") {
      const next = argv[i + 1];
      if (!next) fail("missing value for --traces-dir");
      tracesDir = next as string;
      i += 1;
    } else if (arg === "--audit") {
      const next = argv[i + 1];
      if (!next) fail("missing value for --audit");
      auditPath = next as string;
      i += 1;
    } else if (arg.startsWith("--")) {
      fail(`unknown flag ${arg}`);
    } else if (!runId) {
      runId = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  if (!runId) {
    fail("usage: pnpm trace:show <runId> [--json] [--traces-dir <dir>] [--audit <path>]");
  }
  // Same traversal guard as the API resume path: the run id names a file.
  if (runId.includes("/") || runId.includes("\\") || runId.includes("..")) {
    fail(`invalid runId '${runId}'`);
  }
  return { runId, json, tracesDir, auditPath };
}

function readJsonLines(file: string, required: boolean): unknown[] {
  if (!existsSync(file)) {
    if (required) fail(`trace file missing: ${file}`);
    console.error(`[trace:show] warning: audit file missing: ${file}`);
    return [];
  }
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
  const out: unknown[] = [];
  lines.forEach((line, index) => {
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      if (required) {
        fail(`${file}:${index + 1} is not valid JSON`);
      }
      console.error(`[trace:show] warning: skipping ${file}:${index + 1} (not valid JSON)`);
    }
  });
  return out;
}

function printNode(node: TreeNode, depth: number): void {
  const indent = "  ".repeat(depth);
  const attempt = node.attempt !== undefined ? ` attempt=${node.attempt}` : "";
  console.log(`${indent}${node.node}.${node.type} ${node.durationMs}ms${attempt}`);
  for (const child of node.children) printNode(child, depth + 1);
}

function printAudit(audit: TreeAuditLine): void {
  const parts = [`${audit.tool} ${audit.decision}`];
  if (audit.rowCount !== undefined) parts.push(`rows=${audit.rowCount}`);
  if (audit.durationMs !== undefined) parts.push(`${audit.durationMs}ms`);
  if (audit.maskedColumns.length > 0) {
    parts.push(`masked=[${audit.maskedColumns.join(", ")}]`);
  }
  if (audit.rowScopeApplied.length > 0) {
    parts.push(
      `scope=[${audit.rowScopeApplied.map((scope) => `${scope.table}.${scope.column}`).join(", ")}]`,
    );
  }
  if (audit.errorCode !== undefined) parts.push(`error=${audit.errorCode}`);
  console.log(`  - ${parts.join(" ")}`);
}

function printTree(tree: TraceTree): void {
  console.log(`run ${tree.runId} (${tree.eventCount} events)`);
  for (const root of tree.roots) printNode(root, 1);
  console.log(`audit (${tree.audits.length} lines)`);
  for (const audit of tree.audits) printAudit(audit);
  const summary = tree.summary;
  if (!summary) {
    console.log("summary: no run_done event");
    return;
  }
  console.log("summary");
  console.log(`  status: ${summary.status}`);
  console.log(`  llmCalls: ${summary.llmCalls}`);
  console.log(`  inputTokens: ${summary.inputTokens}`);
  console.log(`  outputTokens: ${summary.outputTokens}`);
  console.log(`  estimatedCostUsd: ${summary.estimatedCostUsd}`);
  console.log(`  toolCalls: ${summary.toolCalls}`);
  console.log(`  sqlAttempts: ${summary.sqlAttempts}`);
  console.log(`  sqlFailures: ${summary.sqlFailures}`);
  console.log(`  repairs: ${summary.repairs}`);
  console.log(`  maskedColumns: [${summary.maskedColumns.join(", ")}]`);
  console.log(
    `  approvals: requested=${summary.approvals.requested} decided=${summary.approvals.decided}`,
  );
}

function main(): void {
  const { runId, json, tracesDir, auditPath } = parseArgs(process.argv.slice(2));
  const events = readJsonLines(path.join(tracesDir, `${runId}.jsonl`), true);
  const audits = readJsonLines(auditPath, false);
  const tree = buildTraceTree(runId, events, audits);
  if (json) {
    console.log(JSON.stringify(tree));
  } else {
    printTree(tree);
  }
}

main();

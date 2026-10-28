// Append-only audit sink (MCP-08, T-01-08-04): exactly one PII-redacted
// JSONL line per tool/resource call to logs/mcp_audit.jsonl. pino's
// synchronous destination guarantees the line hits disk before the handler
// returns; the record is serialized, SQL string literals are masked, and the
// shared redactor scrubs residual PII before the single write.
import { mkdirSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import { redactPII } from "@shared/access-policy";

export interface AuditRecord {
  ts: string;
  runId: string;
  userId: string;
  role: string;
  clientId: string;
  scopes: string[];
  tool: string;
  params: unknown;
  rowCount: number;
  durationMs: number;
  decision: "allow" | "deny";
  errorCode?: string;
  explainCost?: number | null;
  piiHits: number;
}

type Destination = { write(line: string): unknown };

let destination: Destination | null = null;

export function initAudit(auditPath: string): void {
  mkdirSync(path.dirname(auditPath), { recursive: true });
  destination = pino.destination({
    dest: auditPath,
    sync: true,
  }) as unknown as Destination;
}

/** Test seam: direct the single-line writer at an injected sink. */
export function setAuditDestinationForTests(sink: Destination | null): void {
  destination = sink;
}

// SQL string literals ('...') can carry PII or filter secrets; the audit
// trail keeps shapes, never values.
function maskSqlLiterals(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(maskSqlLiterals);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] =
        key === "sql" && typeof entry === "string"
          ? entry.replace(/'[^']*'/g, "'?'")
          : maskSqlLiterals(entry);
    }
    return out;
  }
  return value;
}

export function auditCall(record: AuditRecord): void {
  if (destination === null) return;
  const masked = { ...record, params: maskSqlLiterals(record.params) };
  const line = redactPII(JSON.stringify(masked)).redacted;
  destination.write(`${line}\n`);
}

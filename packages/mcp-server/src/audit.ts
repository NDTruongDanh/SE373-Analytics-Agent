import { mkdirSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import { redactPII, type RowScopeApplied } from "@shared/access-policy";

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
  maskedColumns: string[];
  /** Server-minted `{ table, column }` pairs only — never filter values. */
  rowScopeApplied: RowScopeApplied[];
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

export function setAuditDestinationForTests(sink: Destination | null): void {
  destination = sink;
}

// Mask SQL string literals so filter secrets or PII never reach the audit log.
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

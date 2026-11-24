import { useState } from "react";
import type { EvidencePointer, InsightReport } from "@shared/contracts";
import { AlertTriangle, BarChart3, CheckCircle2, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface InsightPanelProps {
  report: InsightReport;
  resultPreview?: Record<string, unknown>[];
  truncated?: boolean;
  activeEvidence?: EvidencePointer | null;
  onSelectEvidence?: (pointer: EvidencePointer | null) => void;
}

const CHART_TYPE_LABELS: Record<InsightReport["chartType"], string> = {
  line: "Biểu đồ đường (LineChart)",
  bar: "Biểu đồ cột (BarChart)",
  pie: "Biểu đồ tròn (PieChart)",
  scatter: "Biểu đồ phân tán (ScatterChart)",
  table: "Bảng dữ liệu (Table)",
  none: "Tóm tắt số liệu (None)",
};

const TRUNCATION_NOTICE =
  "Kết quả truy vấn đã bị cắt (truncated); không suy diễn tổng hoặc tỷ trọng từ tập dữ liệu xem trước.";

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cellValueMatches(cell: unknown, target: EvidencePointer["value"]): boolean {
  if (cell === target) return true;
  if (cell !== null && cell !== undefined && String(cell) === String(target)) {
    return true;
  }
  const actualNum = toFiniteNumber(cell);
  const targetNum = toFiniteNumber(target);
  if (actualNum !== null && targetNum !== null) {
    const denom = Math.max(Math.abs(targetNum), 1e-9);
    return Math.abs(actualNum - targetNum) / denom <= 0.01;
  }
  return false;
}

function rowMatchesKey(
  row: Record<string, unknown>,
  rowIndex: number,
  rowKey: string,
): boolean {
  for (const cell of Object.values(row)) {
    if (cell === rowKey || (cell !== null && cell !== undefined && String(cell) === rowKey)) {
      return true;
    }
  }
  return rowKey === String(rowIndex) || rowKey === `row_${rowIndex}`;
}

export function findMatchingPreviewRows(
  rows: Record<string, unknown>[],
  pointer: EvidencePointer | null | undefined,
): Set<number> {
  if (!pointer || rows.length === 0) return new Set();
  const keyMatches: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row && rowMatchesKey(row, i, pointer.rowKey)) {
      keyMatches.push(i);
    }
  }
  if (keyMatches.length <= 1) {
    return new Set(keyMatches);
  }
  const valueMatches = keyMatches.filter((idx) => {
    const row = rows[idx];
    return row !== undefined && pointer.column in row && cellValueMatches(row[pointer.column], pointer.value);
  });
  return new Set(valueMatches.length > 0 ? valueMatches : keyMatches);
}

export function cellMatchesEvidence(
  _row: Record<string, unknown>,
  rowIndex: number,
  column: string,
  pointer: EvidencePointer | null | undefined,
  matchedRows: Set<number>,
): boolean {
  if (!pointer) return false;
  return matchedRows.has(rowIndex) && column === pointer.column;
}

function sameEvidence(
  a: EvidencePointer | null | undefined,
  b: EvidencePointer | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.column === b.column &&
    a.rowKey === b.rowKey &&
    String(a.value) === String(b.value)
  );
}

export function InsightPanel({
  report,
  resultPreview,
  truncated = false,
  activeEvidence,
  onSelectEvidence,
}: InsightPanelProps) {
  const [internalEvidence, setInternalEvidence] = useState<EvidencePointer | null>(null);
  const selectedEvidence = activeEvidence !== undefined ? activeEvidence : internalEvidence;

  const effectiveCaveats = report.caveats
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (
    truncated &&
    !effectiveCaveats.some((c) => /(truncat|bị cắt|partial result)/i.test(c))
  ) {
    effectiveCaveats.push(TRUNCATION_NOTICE);
  }

  const previewRows = Array.isArray(resultPreview) ? resultPreview : [];
  const columns = previewRows.length
    ? [...new Set(previewRows.flatMap((row) => Object.keys(row)))]
    : [];
  const matchedRows = findMatchingPreviewRows(previewRows, selectedEvidence);

  function handleToggleEvidence(pointer: EvidencePointer) {
    const next = sameEvidence(selectedEvidence, pointer) ? null : pointer;
    if (activeEvidence === undefined) {
      setInternalEvidence(next);
    }
    onSelectEvidence?.(next);
  }

  return (
    <section
      className="insight-panel mt-3 space-y-3 rounded-xl border border-border bg-card p-4 text-xs shadow-xs"
      aria-label="Bảng nhận định và dẫn chứng UC-03"
      data-testid="insight-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant="success">
            <BarChart3 className="size-3" aria-hidden="true" />
            {CHART_TYPE_LABELS[report.chartType]}
          </Badge>
          {report.insights.length > 0 && (
            <Badge variant="outline">
              <CheckCircle2 className="size-3 text-primary" aria-hidden="true" />
              {report.insights.length} nhận định đã xác minh
            </Badge>
          )}
        </div>
      </div>

      <p
        className="text-muted-foreground leading-relaxed"
        data-testid="insight-chart-reason"
      >
        {report.chartReason}
      </p>

      {effectiveCaveats.length > 0 && (
        <div
          role="note"
          aria-label="Lưu ý và cảnh báo dữ liệu"
          data-testid="insight-caveats"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900"
        >
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-900">
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            <span>Lưu ý &amp; giới hạn dữ liệu</span>
          </div>
          <ul className="m-0 list-disc space-y-1 pl-4">
            {effectiveCaveats.map((caveat, index) => (
              <li key={`${index}-${caveat}`}>{caveat}</li>
            ))}
          </ul>
        </div>
      )}

      {report.insights.length > 0 && (
        <ul className="m-0 list-none space-y-2.5 p-0" data-testid="insight-claims">
          {report.insights.map((item, claimIndex) => (
            <li
              key={claimIndex}
              className="rounded-lg border border-border bg-muted/40 p-3 space-y-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="m-0 flex-1 text-foreground leading-relaxed font-medium">
                  {item.claim}
                </p>
                {item.derivation && (
                  <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                    {item.derivation}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {item.evidence.map((ev, evIndex) => {
                  const isSelected = sameEvidence(selectedEvidence, ev);
                  return (
                    <button
                      key={`${ev.column}-${ev.rowKey}-${evIndex}`}
                      type="button"
                      data-testid="evidence-badge"
                      data-column={ev.column}
                      data-row-key={ev.rowKey}
                      aria-pressed={isSelected}
                      onClick={() => handleToggleEvidence(ev)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-card text-accent-foreground hover:bg-accent",
                      )}
                    >
                      <Link2 className="size-3 shrink-0" aria-hidden="true" />
                      <span>
                        {ev.column} · {ev.rowKey} = {String(ev.value)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}

      {selectedEvidence && (
        <div
          className="rounded-lg border border-primary/30 bg-accent/60 px-3 py-2 text-[11px] text-accent-foreground"
          data-testid="active-evidence-status"
          role="status"
        >
          Đang đối chiếu dẫn chứng: <strong>{selectedEvidence.column}</strong> ·{" "}
          <span>{selectedEvidence.rowKey}</span> ={" "}
          <strong>{String(selectedEvidence.value)}</strong>
          {previewRows.length > 0 && matchedRows.size === 0 && (
            <span className="ml-1 text-muted-foreground">
              (không tìm thấy dòng khớp trong bản xem trước)
            </span>
          )}
        </div>
      )}

      {previewRows.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
            <span>Dữ liệu xem trước đối chiếu ({previewRows.length} dòng)</span>
            {selectedEvidence && (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  if (activeEvidence === undefined) setInternalEvidence(null);
                  onSelectEvidence?.(null);
                }}
              >
                Bỏ chọn dẫn chứng
              </button>
            )}
          </div>
          <div
            className="rounded-lg border border-border bg-card"
            data-testid="insight-preview-table"
          >
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column}>{column}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {previewRows.slice(0, 50).map((row, rowIndex) => {
                  const rowHighlighted = matchedRows.has(rowIndex);
                  return (
                    <TableRow
                      key={rowIndex}
                      data-highlighted-row={rowHighlighted ? "true" : undefined}
                      className={rowHighlighted ? "bg-accent/60" : undefined}
                    >
                      {columns.map((column) => {
                        const cellHighlighted = cellMatchesEvidence(
                          row,
                          rowIndex,
                          column,
                          selectedEvidence,
                          matchedRows,
                        );
                        return (
                          <TableCell
                            key={column}
                            data-highlighted-cell={cellHighlighted ? "true" : undefined}
                            className={
                              cellHighlighted
                                ? "bg-primary/15 font-semibold text-accent-foreground ring-1 ring-inset ring-primary/40"
                                : undefined
                            }
                          >
                            {formatCell(row[column])}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
}

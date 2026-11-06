import type { SQLAnswer, SseProgressEvent } from "@shared/contracts";
import { useState } from "react";

interface Props { answer?: SQLAnswer; events: SseProgressEvent[] }

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** A deliberately simple, text-only line comparison; no HTML from SQL is interpreted. */
function changes(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  return [...oldLines.slice(0, prefix).map((line) => `  ${line}`), ...oldLines.slice(prefix, oldLines.length - suffix).map((line) => `- ${line}`), ...newLines.slice(prefix, newLines.length - suffix).map((line) => `+ ${line}`), ...oldLines.slice(oldLines.length - suffix).map((line) => `  ${line}`)].join("\n");
}

export function ResultDrawer({ answer, events }: Props) {
  const [open, setOpen] = useState(false);
  const sqlEvent = [...events].reverse().find((event) => event.event === "sql_generated");
  const sqlData = sqlEvent?.data && typeof sqlEvent.data === "object" ? sqlEvent.data as Record<string, unknown> : null;
  const tables = Array.isArray(sqlData?.tablesUsed) ? sqlData.tablesUsed.filter((value): value is string => typeof value === "string") : [];
  const columns = answer ? [...new Set(answer.resultPreview.flatMap((row) => Object.keys(row)))] : [];
  return <section className="details">
    <button className="details-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="result-details">
      <span>SQL &amp; nguồn tham chiếu</span><span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {open && <div id="result-details" className="details-body">
      {!answer ? <>
        <p>Chi tiết kết quả chưa được API cung cấp.</p>
        {typeof sqlData?.statementType === "string" && <p>Loại truy vấn: <strong>{sqlData.statementType}</strong></p>}
        {tables.length > 0 && <p>Bảng: {tables.join(", ")}</p>}
      </> : <>
        <h3>SQL</h3><pre>{answer.sql ?? "Không có SQL."}</pre>
        <h3>Các lần thực thi</h3>
        {answer.attempts.length === 0 && <p>Không có lần thực thi.</p>}
        {answer.attempts.map((attempt, index) => <div key={attempt.attemptNo} className="attempt">
          <strong>Lần {attempt.attemptNo}</strong> · {attempt.validation} · {attempt.durationMs} ms
          {attempt.repairReason && <p>{attempt.repairReason}</p>}
          {attempt.sql && <pre>{attempt.sql}</pre>}
          {index > 0 && attempt.sql && answer.attempts[index - 1]?.sql && <details><summary>So sánh với lần trước</summary><pre>{changes(answer.attempts[index - 1].sql!, attempt.sql)}</pre></details>}
        </div>)}
        <h3>Nguồn tham chiếu</h3>
        {answer.citations.length ? <ul>{answer.citations.map((citation, i) => <li key={`${citation}-${i}`}>{citation}</li>)}</ul> : <p>Không có nguồn tham chiếu.</p>}
        <h3>Dữ liệu xem trước <small>({answer.resultPreview.length}/50 dòng)</small></h3>
        {answer.resultPreview.length ? <div className="table-wrap"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>
          {answer.resultPreview.slice(0, 50).map((row, i) => <tr key={i}>{columns.map((column) => <td key={column}>{valueText(row[column])}</td>)}</tr>)}
        </tbody></table></div> : <p>Không có dòng dữ liệu.</p>}
        <h3>Thống kê</h3><p>{answer.telemetry.latencyMs} ms · {answer.telemetry.promptTokens} input tokens · {answer.telemetry.completionTokens} output tokens · {answer.telemetry.embeddingTokens} embedding tokens · ${answer.telemetry.estimatedCostUsd.toFixed(4)}</p>
      </>}
    </div>}
  </section>;
}

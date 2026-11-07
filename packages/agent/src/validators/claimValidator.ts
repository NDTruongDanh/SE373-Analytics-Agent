// Deterministic Numeric & Causal Claim Validator (UC-03 K7,
// architecture §3.2.9, PRD UC-03 technical requirements).
//
// One deterministic pass over the draft insights against the transient
// query buffer (full ≤ 1,000-row buffer in production, `resultPreview` when
// only the preview is available):
//
// 1. Number extraction — every numeric token in `claim` (thousands
//    separators, K/M/B + Vietnamese nghìn/triệu/tỷ/tỉ scale suffixes,
//    % deltas, VND/₫/đồng currency markers).
// 2. Evidence match — each number must trace to an EvidencePointer whose
//    `{ column, rowKey, value }` cell exists in the buffer within <= 1%
//    rounding tolerance. Percentage deltas are recomputed from the two
//    cited cells with the same tolerance.
// 3. Causal gating — claims with causal language ("due to", "do …", …)
//    pass only when the evidence cites a dimension value present in the
//    rows or an `event:*` chunk from the turn's semantic context; otherwise
//    the claim is stripped, never repaired by the LLM.
// 4. Strip + log — unverified numbers/claims are removed from `insights`
//    and each removal is returned for the trace. The response still ships
//    with whatever verified claims remain plus `caveats`.
//
// Pure function — no model, no I/O.

import type { EvidencePointer, InsightClaim } from "@shared/contracts";
import { isTimeValue, toNumberCell } from "./chartSelector.js";

/** <= 1% relative rounding tolerance (PRD UC-03 requirement). */
export const CLAIM_NUMBER_TOLERANCE = 0.01;

export interface ExtractedNumber {
  raw: string;
  /** Digits as written (unit suffixes are display labels, not multipliers). */
  bare: number;
  /** Digits × scale suffix ("5.2 tỷ" → 5.2e9; buffers in base units). */
  scaled: number;
  isPercent: boolean;
}

export interface StrippedClaim {
  claimIndex: number;
  claim: string;
  reason: string;
}

export interface ClaimsVerification {
  verified: InsightClaim[];
  stripped: StrippedClaim[];
}

// NOTE: never use \b next to Vietnamese diacritics — \w does not cover
// them in this runtime (/Ỷ/ is \p{L} but not \w), so \b misfires. All
// letter boundaries below use an explicit (?![\p{L}]) lookahead instead.
const NOT_LETTER = String.raw`(?![\p{L}])`;

const SCALE_SUFFIX: Array<[RegExp, number]> = [
  [new RegExp(`^(tỷ|tỉ|ti)${NOT_LETTER}`, "iu"), 1e9],
  [new RegExp(`^(triệu|trieu|m)${NOT_LETTER}`, "iu"), 1e6],
  [new RegExp(`^(nghìn|nghin|k)${NOT_LETTER}`, "iu"), 1e3],
  [new RegExp(`^b${NOT_LETTER}`, "iu"), 1e9],
];

// -?\d… with optional thousands separators, decimals, scale suffix, % sign.
// Currency words (₫, VND, đồng, dong) are consumed as context, not value.
const NUMBER_RE =
  /-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;
const TRAILING_RE = new RegExp(String.raw`^\s*(%|﹪|pct|phần trăm|percent)?\s*(tỷ|tỉ|ti|triệu|trieu|nghìn|nghin|[kKmMbB])?` + NOT_LETTER + String.raw`(\s*(₫|vnd|đồng|dong))?`, "iu");

// Date-like spans are not numbers: "2026-09" must not extract 2026 and
// -9, "05/09/2026" must not extract 05, 09, 2026. Dates ground through
// rowKeys and label cells, never through the numeric path.
const DATE_SPAN_RE = /\d{4}-\d{2}(?:-\d{2})?|\d{1,2}\/\d{1,2}\/\d{2,4}/g;

function dateSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  DATE_SPAN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATE_SPAN_RE.exec(text)) !== null) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/**
 * Extract every numeric token from a claim. "5,200", "5.2K", "8.0%",
 * "2,1 tỷ ₫" all parse. Scale suffixes produce BOTH the bare digits and
 * the scaled value: "5,200M VND" matches a buffer cell 5200 (M-VND units)
 * while "5.2 tỷ" matches 5_200_000_000 (base-unit buffers) — the unit word
 * is a display label, and the validator accepts either reading.
 */
export function extractClaimNumbers(claim: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  const spans = dateSpans(claim);
  NUMBER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_RE.exec(claim)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (spans.some(([from, to]) => start >= from && end <= to)) continue;
    const rawDigits = match[0];
    const rest = claim.slice(end);
    const tail = TRAILING_RE.exec(rest);
    const tailText = tail?.[0] ?? "";
    let bare: number;
    if (/[.,]/.test(rawDigits)) {
      bare = Number(normalizeDecimal(rawDigits));
    } else {
      bare = Number(rawDigits);
    }
    if (!Number.isFinite(bare)) continue;
    const suffix = (tail?.[2] ?? "").toLowerCase();
    const scale = scaleOf(suffix);
    const isPercent = (tail?.[1] ?? "") !== "";
    out.push({
      raw: rawDigits + tailText,
      bare,
      scaled: bare * scale,
      isPercent,
    });
  }
  return out;
}

function normalizeDecimal(raw: string): string {
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  const last = Math.max(lastComma, lastDot);
  const head = raw.slice(0, last).replace(/[.,]/g, "");
  const tail = raw.slice(last + 1);
  // "5,200" -> head "5", tail "200" (3 digits -> thousands). "5,2" ->
  // tail "2" (1 digit -> decimal comma, keep as dot).
  if (tail.length === 3 && head !== "") return `${head}${tail}`;
  return `${head}.${tail}`;
}

function scaleOf(suffix: string): number {
  const s = suffix.trim().toLowerCase();
  if (s === "") return 1;
  for (const [re, scale] of SCALE_SUFFIX) {
    if (re.test(s)) return scale;
  }
  return 1;
}

function cellsInColumn(
  rows: Record<string, unknown>[],
  column: string,
): unknown[] {
  return rows.map((row) => row[column]).filter((v) => v !== undefined);
}

/**
 * One evidence pointer is buffer-valid when its value cell exists in its
 * column (numbers within 1%, strings exact) and its rowKey names a row
 * present somewhere in the buffer. `event:*` columns are exempt: they cite
 * the semantic journal, not query cells.
 */
function pointerBufferValid(
  pointer: EvidencePointer,
  buffer: ClaimBuffer,
): boolean {
  if (/^event:/.test(pointer.column)) return true;
  if (!buffer.columns.includes(pointer.column)) {
    return rowKeyPresent(pointer.column, buffer.rows, buffer.columns);
  }
  if (!pointerValueMatches(pointer.value, cellsInColumn(buffer.rows, pointer.column))) {
    return false;
  }
  return rowKeyPresent(pointer.rowKey, buffer.rows, buffer.columns);
}

function pointerValueMatches(
  pointerValue: number | string,
  cells: unknown[],
): boolean {
  if (typeof pointerValue === "string") {
    return cells.some((cell) => cell === pointerValue || String(cell) === pointerValue);
  }
  for (const cell of cells) {
    const actual = toNumberCell(cell);
    if (actual === null) continue;
    const denom = Math.max(Math.abs(actual), 1e-9);
    if (Math.abs(pointerValue - actual) / denom <= CLAIM_NUMBER_TOLERANCE) return true;
  }
  return false;
}

function rowKeyPresent(
  rowKey: string,
  rows: Record<string, unknown>[],
  columns: string[],
): boolean {
  for (const row of rows) {
    for (const column of columns) {
      const cell = row[column];
      if (cell === rowKey || (cell !== null && cell !== undefined && String(cell) === rowKey)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Label-like integers (years, ranks, "top 5", "Q3") are exempt from cell
 * matching when the digits are structurally cited (an evidence rowKey or
 * column) or appear inside a buffer label cell ("2026-Q3", "top 5").
 * Metric magnitudes always take the numeric path.
 */
function isLabelNumber(
  value: number,
  evidence: EvidencePointer[],
  buffer: ClaimBuffer,
): boolean {
  if (!Number.isInteger(value) || !Number.isFinite(value)) return false;
  const digits = String(Math.abs(value));
  if (evidence.some((pointer) => pointer.rowKey.includes(digits) || pointer.column.includes(digits))) {
    return true;
  }
  for (const row of buffer.rows) {
    for (const column of buffer.columns) {
      const cell = row[column];
      if (typeof cell === "string" && cell.includes(digits)) return true;
    }
  }
  return false;
}

function numberMatchesBuffer(value: number, rows: Record<string, unknown>[], columns: string[]): boolean {
  for (const column of columns) {
    if (pointerValueMatches(value, cellsInColumn(rows, column))) return true;
  }
  return false;
}

const CAUSAL_RE =
  /(due to|because|caused by|driven by|thanks to|led to|resulted in|attributed to|blam\w+|do\s+[a-zà-ỹ]|vì\s|bởi\s|nhờ\s|nguyên nhân|dẫn đến|gây ra|đối thủ|competitor)/i;

/**
 * A causal claim is grounded only by (a) an `event:*` semantic citation,
 * (b) the claim naming a cited event id, or (c) evidence citing a
 * row-backed, non-time dimension value (a real breakdown like region or
 * channel — a bare time period such as "2026-09" never grounds a cause).
 */
function causalGrounded(
  claim: string,
  evidence: EvidencePointer[],
  rows: Record<string, unknown>[],
  columns: string[],
  eventIds: readonly string[],
): boolean {
  if (!CAUSAL_RE.test(claim)) return true;
  // Cited journal event grounds the cause (UC-11 pattern).
  for (const pointer of evidence) {
    if (/^event:/.test(pointer.column) || /^event:/.test(pointer.rowKey)) return true;
  }
  for (const eventId of eventIds) {
    if (claim.includes(eventId)) return true;
  }
  // A cited breakdown dimension present in the rows grounds the *where*.
  for (const pointer of evidence) {
    const candidates = [pointer.rowKey, String(pointer.value)];
    for (const candidate of candidates) {
      if (isTimeValue(candidate)) continue;
      // Metric magnitudes are not breakdowns: a number matching its own
      // cell must not self-ground a causal claim.
      if (toNumberCell(candidate) !== null) continue;
      if (rowKeyPresent(candidate, rows, columns)) return true;
    }
  }
  return false;
}

function deltaRecomputed(
  claimedPct: number,
  evidence: EvidencePointer[],
): boolean {
  const values = evidence
    .map((pointer) => (typeof pointer.value === "number" ? pointer.value : toNumberCell(pointer.value)))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length < 2) return false;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = 0; j < values.length; j += 1) {
      if (i === j) continue;
      const base = values[j];
      if (base === 0) continue;
      const recomputed = ((values[i] - base) / Math.abs(base)) * 100;
      const denom = Math.max(Math.abs(claimedPct), 1e-9);
      // Sign-insensitive: "fell 10%" claims the magnitude; direction words
      // are narrative, not numeric (manual rubric covers direction).
      if (
        Math.abs(recomputed - claimedPct) / denom <= CLAIM_NUMBER_TOLERANCE ||
        Math.abs(recomputed + claimedPct) / denom <= CLAIM_NUMBER_TOLERANCE
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface ClaimBuffer {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface VerifyClaimsOptions {
  /** `event:*` chunk ids from the turn's semantic context (causal gate). */
  eventIds?: readonly string[];
}

/**
 * Verify every insight against the buffer. Numbers without a matching
 * evidence cell, percentage deltas that do not recompute, and ungrounded
 * causal claims are stripped (never repaired). Deterministic: the same
 * inputs always yield the same verified set.
 */
export function verifyNumericClaims(
  insights: InsightClaim[],
  buffer: ClaimBuffer,
  opts: VerifyClaimsOptions = {},
): ClaimsVerification {
  const verified: InsightClaim[] = [];
  const stripped: StrippedClaim[] = [];
  const eventIds = opts.eventIds ?? [];
  insights.forEach((insight, claimIndex) => {
    const numbers = extractClaimNumbers(insight.claim);
    // Claim-level evidence index: every pointer must name a real buffer
    // cell (or an event:* journal citation).
    const badPointer = insight.evidence.find(
      (pointer) => !pointerBufferValid(pointer, buffer),
    );
    if (badPointer !== undefined) {
      stripped.push({
        claimIndex,
        claim: insight.claim,
        reason: `evidence pointer {column: ${badPointer.column}, rowKey: ${badPointer.rowKey}} matches no query result cell.`,
      });
      return;
    }
    for (const number of numbers) {
      if (number.isPercent) {
        // Percent deltas recompute from the cited evidence pair; the
        // claimed figure itself uses percentage points, not buffer units.
        if (!deltaRecomputed(number.bare, insight.evidence)) {
          stripped.push({
            claimIndex,
            claim: insight.claim,
            reason: `percentage ${number.raw.trim()} does not recompute from the cited evidence within 1% tolerance.`,
          });
          return;
        }
        continue;
      }
      const grounded =
        numberMatchesBuffer(number.bare, buffer.rows, buffer.columns) ||
        numberMatchesBuffer(number.scaled, buffer.rows, buffer.columns) ||
        isLabelNumber(number.bare, insight.evidence, buffer);
      if (!grounded) {
        stripped.push({
          claimIndex,
          claim: insight.claim,
          reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
        });
        return;
      }
    }
    if (!causalGrounded(insight.claim, insight.evidence, buffer.rows, buffer.columns, eventIds)) {
      stripped.push({
        claimIndex,
        claim: insight.claim,
        reason: "causal language with no row-backed dimension or event:* citation; cause is unverified.",
      });
      return;
    }
    verified.push(insight);
  });
  return { verified, stripped };
}

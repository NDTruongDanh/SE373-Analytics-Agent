import type {
  ClaimDerivation,
  EvidencePointer,
  InsightClaim,
} from "@shared/contracts";
import { isTimeValue, toNumberCell } from "./chartSelector.js";

export const CLAIM_NUMBER_TOLERANCE = 0.01;

export interface ExtractedNumber {
  raw: string;
  bare: number;
  scaled: number;
  isPercent: boolean;
  isPercentagePoint: boolean;
  index: number;
}

export interface StrippedClaim {
  claimIndex: number;
  claim: string;
  expected?: string;
  found?: string;
  reason: string;
}

export interface ClaimsVerification {
  verified: InsightClaim[];
  stripped: StrippedClaim[];
  truncationCaveatRequired: boolean;
}

// Never use \b near Vietnamese diacritics (\w excludes them in JS regex); use Unicode lookarounds instead.
const PREV_NOT_LETTER = String.raw`(?<![\p{L}])`;
const NOT_LETTER = String.raw`(?![\p{L}])`;

const SCALE_SUFFIX: Array<[RegExp, number]> = [
  [new RegExp(`^(tỷ|tỉ|ti)${NOT_LETTER}`, "iu"), 1e9],
  [new RegExp(`^(triệu|trieu|m)${NOT_LETTER}`, "iu"), 1e6],
  [new RegExp(`^(nghìn|nghin|k)${NOT_LETTER}`, "iu"), 1e3],
  [new RegExp(`^b${NOT_LETTER}`, "iu"), 1e9],
];

const NUMBER_RE =
  /-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/g;
const PP_SUFFIX_RE = new RegExp(
  String.raw`^\s*(?:điểm\s*(?:%|phần\s*trăm)|percentage\s*points?|pct\s*pts?|pp)${NOT_LETTER}`,
  "iu",
);
const TRAILING_RE = new RegExp(
  String.raw`^\s*(%|﹪|pct|phần trăm|percent)?\s*(tỷ|tỉ|ti|triệu|trieu|nghìn|nghin|[kKmMbB])?` +
    NOT_LETTER +
    String.raw`(\s*(₫|vnd|đồng|dong))?`,
  "iu",
);

// Exclude date spans from numeric extraction; dates ground through rowKeys/label cells instead.
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
    let bare: number;
    if (/[.,]/.test(rawDigits)) {
      bare = Number(normalizeDecimal(rawDigits));
    } else {
      bare = Number(rawDigits);
    }
    if (!Number.isFinite(bare)) continue;

    const ppMatch = PP_SUFFIX_RE.exec(rest);
    if (ppMatch) {
      out.push({
        raw: rawDigits + ppMatch[0],
        bare,
        scaled: bare,
        isPercent: false,
        isPercentagePoint: true,
        index: start,
      });
      continue;
    }

    const tail = TRAILING_RE.exec(rest);
    const tailText = tail?.[0] ?? "";
    const suffix = (tail?.[2] ?? "").toLowerCase();
    const scale = scaleOf(suffix);
    const isPercent = (tail?.[1] ?? "") !== "";
    out.push({
      raw: rawDigits + tailText,
      bare,
      scaled: bare * scale,
      isPercent,
      isPercentagePoint: false,
      index: start,
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
  // Three-digit trailing group with a non-empty head is treated as thousands ("5,200"); otherwise decimal ("5,2").
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

function approxEqual(a: number, b: number, tolerance = CLAIM_NUMBER_TOLERANCE): boolean {
  const denom = Math.max(Math.abs(b), 1e-9);
  return Math.abs(a - b) / denom <= tolerance;
}

/** event:* columns cite the semantic journal rather than query cells and are exempt from buffer lookup. */
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
    if (approxEqual(pointerValue, actual)) return true;
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

/** Exempt structural label integers (years, ranks, quarters) cited in rowKeys, columns, or label cells. */
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

function numberMatchesBuffer(
  value: number,
  rows: Record<string, unknown>[],
  columns: string[],
): boolean {
  for (const column of columns) {
    if (pointerValueMatches(value, cellsInColumn(rows, column))) return true;
  }
  return false;
}

const POSITIVE_DIRECTION_RE = new RegExp(
  `(?:${PREV_NOT_LETTER}(?:tăng\\s*trưởng|tăng|cao\\s+hơn|lớn\\s+hơn|nhiều\\s+hơn|vượt|cải\\s+thiện|đi\\s+lên|nhích\\s+lên|bật\\s+tăng|grew|growing|growth|grow|increased|increasing|increase|rose|rising|rise|higher|above|surged|jumped|climbed|gained|expanded|improved)${NOT_LETTER}|(?<![\\p{L}-])up(?![\\p{L}-])(?!\\s+to${NOT_LETTER}))`,
  "iu",
);

const NEGATIVE_DIRECTION_RE = new RegExp(
  `(?:${PREV_NOT_LETTER}(?:sụt\\s*giảm|suy\\s*giảm|giảm|thấp\\s+hơn|ít\\s+hơn|nhỏ\\s+hơn|đi\\s+xuống|lao\\s+dốc|thu\\s+hẹp|fell|falling|fall|decreased|decreasing|decrease|dropped|dropping|drop|lower|below|declined|declining|decline|slumped|shrank|contracted|lost|plunged)${NOT_LETTER}|(?<![\\p{L}-])down(?![\\p{L}-]))`,
  "iu",
);

export function detectClaimPolarity(text: string): 1 | -1 | 0 | "mixed" {
  const pos = POSITIVE_DIRECTION_RE.test(text);
  const neg = NEGATIVE_DIRECTION_RE.test(text);
  if (pos && neg) return "mixed";
  if (pos) return 1;
  if (neg) return -1;
  return 0;
}

/** Used to avoid shipping a one-sided positive report after stripping a negative claim. */
export function isNegativeMovementClaim(claim: string): boolean {
  return NEGATIVE_DIRECTION_RE.test(claim) || /(?:^|\s)-\d+(?:[.,]\d+)?\s*(?:%|pp|điểm)/i.test(claim);
}

const CAVEAT_CLAIM_RE = new RegExp(
  String.raw`(?:caveat|warning|caution|limitation|partial|incomplete|truncated|sample|only\s+the\s+first|missing|unknown\s+cause|cause\s+unknown|cảnh\s+báo|lưu\s+ý|hạn\s+chế|không\s+đầy\s+đủ|chưa\s+đầy\s+đủ|một\s+phần|bị\s+cắt|giới\s+hạn|thiếu\s+dữ\s+liệu|nguyên\s+nhân\s+(?:chưa|không)\s+rõ)`,
  "iu",
);

export function isCaveatClaim(claim: string): boolean {
  return CAVEAT_CLAIM_RE.test(claim);
}

interface NumericPointer {
  pointer: EvidencePointer;
  value: number;
}

function numericPointersOf(evidence: EvidencePointer[]): NumericPointer[] {
  const out: NumericPointer[] = [];
  for (const pointer of evidence) {
    if (/^event:/.test(pointer.column)) continue;
    const num = typeof pointer.value === "number" ? pointer.value : toNumberCell(pointer.value);
    if (num !== null && Number.isFinite(num)) {
      out.push({ pointer, value: num });
    }
  }
  return out;
}

function resolveCurrBase(
  evidence: EvidencePointer[],
): { curr: NumericPointer; base: NumericPointer } | null {
  const nums = numericPointersOf(evidence);
  if (nums.length < 2) return null;
  const first = nums[0];
  const second = nums[1];
  if (
    isTimeValue(first.pointer.rowKey) &&
    isTimeValue(second.pointer.rowKey) &&
    first.pointer.rowKey !== second.pointer.rowKey
  ) {
    if (first.pointer.rowKey > second.pointer.rowKey) {
      return { curr: first, base: second };
    }
    return { curr: second, base: first };
  }
  return { curr: first, base: second };
}

interface PolarityFailure {
  expected: string;
  found: string;
  reason: string;
}

function checkPolarity(
  claim: string,
  curr: number,
  base: number,
  tokenIndex?: number,
  signedValue?: number,
): PolarityFailure | null {
  const actualSign = Math.sign(curr - base);
  if (signedValue !== undefined && signedValue < 0 && actualSign > 0) {
    return {
      expected: "positive change (>= 0)",
      found: `negative value (${signedValue})`,
      reason: `polarity mismatch: evidence shows an increase (${base} -> ${curr}) while claim states a negative delta (${signedValue}).`,
    };
  }
  let polarity: 1 | -1 | 0 | "mixed" = 0;
  if (tokenIndex !== undefined) {
    const windowStart = Math.max(0, tokenIndex - 48);
    const local = claim.slice(windowStart, tokenIndex);
    const localPol = detectClaimPolarity(local);
    if (localPol === 1 || localPol === -1) polarity = localPol;
  }
  if (polarity === 0) {
    const fullPol = detectClaimPolarity(claim);
    if (fullPol === 1 || fullPol === -1) polarity = fullPol;
  }
  if (polarity === 1 && actualSign <= 0) {
    return {
      expected: actualSign < 0 ? "decrease/lower" : "unchanged",
      found: "increase/higher",
      reason: `polarity mismatch: claim uses upward wording while evidence moved from ${base} to ${curr}.`,
    };
  }
  if (polarity === -1 && actualSign >= 0) {
    return {
      expected: actualSign > 0 ? "increase/higher" : "unchanged",
      found: "decrease/lower",
      reason: `polarity mismatch: claim uses downward wording while evidence moved from ${base} to ${curr}.`,
    };
  }
  return null;
}

const CAUSAL_RE =
  /(due to|because|caused by|driven by|thanks to|led to|resulted in|attributed to|blam\w+|do\s+[a-zà-ỹ]|vì\s|bởi\s|nhờ\s|nguyên nhân|dẫn đến|gây ra|đối thủ|competitor)/i;

// Explicit "cause unknown" disclaimers must not trigger causal stripping unless the claim also asserts a cause.
const UNKNOWN_CAUSE_RE =
  /(cause unknown|unknown cause|no causal (?:data|information|evidence)|nguyên nhân (?:chưa|không) rõ|(?:chưa|không) rõ nguyên nhân|(?:chưa|không) xác định được nguyên nhân)/gi;

/** Causal claims require an event:* citation, cited event ID, or non-time breakdown dimension; bare dates never ground a cause. */
function causalGrounded(
  claim: string,
  evidence: EvidencePointer[],
  rows: Record<string, unknown>[],
  columns: string[],
  eventIds: readonly string[],
): boolean {
  const withoutDisclaimers = claim.replace(UNKNOWN_CAUSE_RE, "");
  if (!CAUSAL_RE.test(withoutDisclaimers)) return true;
  for (const pointer of evidence) {
    if (/^event:/.test(pointer.column) || /^event:/.test(pointer.rowKey)) return true;
  }
  for (const eventId of eventIds) {
    if (claim.includes(eventId)) return true;
  }
  for (const pointer of evidence) {
    const candidates = [pointer.rowKey, String(pointer.value)];
    for (const candidate of candidates) {
      if (isTimeValue(candidate)) continue;
      // Skip numeric magnitudes so a metric cell cannot self-ground a causal claim.
      if (toNumberCell(candidate) !== null) continue;
      if (rowKeyPresent(candidate, rows, columns)) return true;
    }
  }
  return false;
}

const SQL_AGG_COL_RE =
  /(total|sum|grand_total|share|pct|percent|ratio|avg|mean|rank|row_num|rn|tong|ty_trong|ti_trong|trung_binh|xep_hang)/i;

const TRUNCATION_AGG_CLAIM_RE = new RegExp(
  String.raw`(?:grand\s+total|overall\s+total|total\s+across\s+all|entire\s+dataset|all\s+rows|share\s+of\s+total|overall\s+average|tổng\s+cộng|tổng\s+toàn\s+bộ|tổng\s+doanh\s+thu\s+toàn|tổng\s+tất\s+cả|tỷ\s+trọng|tỉ\s+trọng|trung\s+bình\s+toàn|xếp\s+hạng|đứng\s+thứ|hạng\s+\d|chiếm\s+\d)`,
  "iu",
);

function isSqlComputedAggregatePointer(
  pointer: EvidencePointer,
  buffer: ClaimBuffer,
  targetValue?: number,
): boolean {
  if (!buffer.columns.includes(pointer.column)) return false;
  if (!SQL_AGG_COL_RE.test(pointer.column)) return false;
  return pointerValueMatches(
    targetValue ?? pointer.value,
    cellsInColumn(buffer.rows, pointer.column),
  );
}

function columnNumericValues(
  rows: Record<string, unknown>[],
  column: string,
): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const num = toNumberCell(row[column]);
    if (num !== null && Number.isFinite(num)) out.push(num);
  }
  return out;
}

function numericColumnPointer(
  evidence: EvidencePointer[],
  buffer: ClaimBuffer,
): { pointer: EvidencePointer; value: number } | null {
  for (const pointer of evidence) {
    if (!buffer.columns.includes(pointer.column)) continue;
    const val = typeof pointer.value === "number" ? pointer.value : toNumberCell(pointer.value);
    if (val !== null && Number.isFinite(val)) {
      return { pointer, value: val };
    }
  }
  return null;
}

function columnFromEvidenceOrBuffer(
  evidence: EvidencePointer[],
  buffer: ClaimBuffer,
): string | null {
  for (const pointer of evidence) {
    if (buffer.columns.includes(pointer.column)) {
      const vals = columnNumericValues(buffer.rows, pointer.column);
      if (vals.length > 0) return pointer.column;
    }
  }
  return null;
}

function numberGroundedInBuffer(
  number: ExtractedNumber,
  evidence: EvidencePointer[],
  buffer: ClaimBuffer,
): boolean {
  return (
    numberMatchesBuffer(number.bare, buffer.rows, buffer.columns) ||
    numberMatchesBuffer(number.scaled, buffer.rows, buffer.columns) ||
    isLabelNumber(number.bare, evidence, buffer)
  );
}

function checkTruncationGate(
  insight: InsightClaim,
  buffer: ClaimBuffer,
  truncated: boolean,
  derivedTarget?: number,
): StrippedClaim | null {
  if (!truncated) return null;
  const derivation = insight.derivation;
  if (
    derivation === "share_of_total" ||
    derivation === "sum" ||
    derivation === "mean" ||
    derivation === "rank"
  ) {
    const backed = insight.evidence.some((ptr) =>
      isSqlComputedAggregatePointer(ptr, buffer, derivedTarget),
    );
    if (!backed) {
      return {
        claimIndex: -1,
        claim: insight.claim,
        expected: "SQL-computed column backing result-set derivation on truncated output",
        found: `derivation=${derivation} over truncated buffer without SQL aggregate column`,
        reason: `result set is truncated; derivation "${derivation}" cannot be computed from partial rows without a SQL-computed column.`,
      };
    }
    return null;
  }
  if (
    (derivation === undefined || derivation === "cell") &&
    TRUNCATION_AGG_CLAIM_RE.test(insight.claim)
  ) {
    const backed = insight.evidence.some((ptr) =>
      isSqlComputedAggregatePointer(ptr, buffer),
    );
    if (!backed) {
      return {
        claimIndex: -1,
        claim: insight.claim,
        expected: "SQL-computed aggregate column for grand-total/share/rank claim on truncated output",
        found: "unbacked whole-result aggregate claim on truncated buffer",
        reason: "result set is truncated; grand-total or whole-result aggregate claim requires a SQL-computed column.",
      };
    }
  }
  return null;
}

function verifyDeclaredDerivation(
  derivation: ClaimDerivation,
  insight: InsightClaim,
  claimIndex: number,
  numbers: ExtractedNumber[],
  buffer: ClaimBuffer,
  truncated: boolean,
): StrippedClaim | null {
  switch (derivation) {
    case "cell": {
      const truncIssue = checkTruncationGate(insight, buffer, truncated);
      if (truncIssue) return { ...truncIssue, claimIndex };
      for (const number of numbers) {
        if (number.isPercentagePoint) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: 'derivation "pp_change" for percentage-point claim',
            found: number.raw.trim(),
            reason: `percentage-point value ${number.raw.trim()} cannot be claimed with derivation "cell".`,
          };
        }
        if (number.isPercent) {
          const direct = pointerValueMatches(
            number.bare,
            insight.evidence.map((pointer) => pointer.value),
          );
          if (!direct) {
            return {
              claimIndex,
              claim: insight.claim,
              expected: "direct percentage cell in evidence",
              found: number.raw.trim(),
              reason: `percentage ${number.raw.trim()} does not match a cited cell under derivation "cell".`,
            };
          }
          continue;
        }
        if (!numberGroundedInBuffer(number, insight.evidence, buffer)) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: "value present in query result cell within 1% tolerance",
            found: number.raw.trim(),
            reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
          };
        }
      }
      return null;
    }

    case "pct_change": {
      if (numbers.some((n) => n.isPercentagePoint)) {
        const pp = numbers.find((n) => n.isPercentagePoint)!;
        return {
          claimIndex,
          claim: insight.claim,
          expected: 'derivation "pp_change" for percentage points',
          found: `${pp.raw.trim()} under pct_change`,
          reason: `percentage-point token ${pp.raw.trim()} cannot be verified as pct_change (never conflate pp_change with pct_change).`,
        };
      }
      const pair = resolveCurrBase(insight.evidence);
      if (!pair || pair.base.value === 0) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: "two numeric evidence cells with non-zero base",
          found: `${insight.evidence.length} pointer(s)`,
          reason: "pct_change requires at least two numeric evidence cells with a non-zero baseline.",
        };
      }
      const expectedPct = ((pair.curr.value - pair.base.value) / Math.abs(pair.base.value)) * 100;
      const pctNumbers = numbers.filter((n) => n.isPercent);
      if (pctNumbers.length === 0) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: `${expectedPct.toFixed(2)}%`,
          found: "no percentage token in claim",
          reason: "pct_change claim must include a percentage value matching the recomputed delta.",
        };
      }
      for (const pct of pctNumbers) {
        if (!approxEqual(Math.abs(pct.bare), Math.abs(expectedPct))) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: `${expectedPct.toFixed(2)}%`,
            found: pct.raw.trim(),
            reason: `percentage ${pct.raw.trim()} does not recompute from the cited evidence (expected ${expectedPct.toFixed(2)}%) within 1% tolerance.`,
          };
        }
        const polErr = checkPolarity(insight.claim, pair.curr.value, pair.base.value, pct.index, pct.bare);
        if (polErr) return { claimIndex, claim: insight.claim, ...polErr };
      }
      for (const number of numbers) {
        if (number.isPercent) continue;
        if (!numberGroundedInBuffer(number, insight.evidence, buffer)) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: "value present in query result cell within 1% tolerance",
            found: number.raw.trim(),
            reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
          };
        }
      }
      return null;
    }

    case "pp_change": {
      const pair = resolveCurrBase(insight.evidence);
      if (!pair) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: "two numeric evidence cells",
          found: `${insight.evidence.length} pointer(s)`,
          reason: "pp_change requires at least two numeric evidence cells.",
        };
      }
      const rawDiff = pair.curr.value - pair.base.value;
      const candidates =
        Math.abs(pair.curr.value) <= 1 && Math.abs(pair.base.value) <= 1
          ? [rawDiff, rawDiff * 100]
          : [rawDiff];

      const ppNumbers = numbers.filter((n) => n.isPercentagePoint);
      const deltaTokens =
        ppNumbers.length > 0
          ? ppNumbers
          : numbers.filter((n) => !n.isPercent && !numberGroundedInBuffer(n, insight.evidence, buffer));

      if (deltaTokens.length === 0) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: `${rawDiff.toFixed(2)} pp`,
          found: "no percentage-point token in claim",
          reason: "pp_change claim must state a percentage-point delta matching (curr - base) (never conflate pp_change with pct_change).",
        };
      }

      const matchedDelta = deltaTokens.find((tok) =>
        candidates.some((exp) => approxEqual(Math.abs(tok.bare), Math.abs(exp))),
      );
      if (!matchedDelta) {
        const expectedLabel =
          candidates.length > 1
            ? `${candidates[0].toFixed(2)} or ${candidates[1].toFixed(2)} pp`
            : `${candidates[0].toFixed(2)} pp`;
        return {
          claimIndex,
          claim: insight.claim,
          expected: expectedLabel,
          found: deltaTokens[0].raw.trim(),
          reason: `percentage-point delta ${deltaTokens[0].raw.trim()} does not match (curr - base) = ${expectedLabel} within 1% tolerance.`,
        };
      }
      const polErr = checkPolarity(
        insight.claim,
        pair.curr.value,
        pair.base.value,
        matchedDelta.index,
        matchedDelta.bare,
      );
      if (polErr) return { claimIndex, claim: insight.claim, ...polErr };

      for (const number of numbers) {
        if (number === matchedDelta) continue;
        if (number.isPercent) {
          const direct = pointerValueMatches(
            number.bare,
            insight.evidence.map((pointer) => pointer.value),
          );
          if (!direct) {
            return {
              claimIndex,
              claim: insight.claim,
              expected: "direct rate cell or pp_change token",
              found: number.raw.trim(),
              reason: `percentage ${number.raw.trim()} cannot substitute for pp_change.`,
            };
          }
          continue;
        }
        if (!numberGroundedInBuffer(number, insight.evidence, buffer)) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: "value present in query result cell within 1% tolerance",
            found: number.raw.trim(),
            reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
          };
        }
      }
      return null;
    }

    case "share_of_total": {
      const ptr = numericColumnPointer(insight.evidence, buffer);
      if (!ptr) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: "numeric evidence pointer from query column",
          found: "none",
          reason: "share_of_total requires a numeric evidence pointer from a query column.",
        };
      }
      if (truncated) {
        const sqlShare = insight.evidence.find((p) =>
          isSqlComputedAggregatePointer(p, buffer),
        );
        if (!sqlShare) {
          const truncIssue = checkTruncationGate(insight, buffer, true);
          return { ...truncIssue!, claimIndex };
        }
        const sqlShareVal = toNumberCell(sqlShare.value);
        const pctTokens = numbers.filter((n) => n.isPercent);
        if (
          sqlShareVal === null ||
          pctTokens.length === 0 ||
          !pctTokens.some((n) => approxEqual(n.bare, sqlShareVal))
        ) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: `${sqlShareVal ?? "SQL share"}%`,
            found: pctTokens[0]?.raw.trim() ?? "none",
            reason: "share_of_total does not match the SQL-computed share column within 1% tolerance.",
          };
        }
        for (const number of numbers) {
          if (number.isPercent) continue;
          if (!numberGroundedInBuffer(number, insight.evidence, buffer)) {
            return {
              claimIndex,
              claim: insight.claim,
              expected: "value present in query result cell",
              found: number.raw.trim(),
              reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
            };
          }
        }
        return null;
      }

      const colValues = columnNumericValues(buffer.rows, ptr.pointer.column);
      const total = colValues.reduce((acc, v) => acc + v, 0);
      if (colValues.length === 0 || total === 0) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: "non-zero column total",
          found: `${total}`,
          reason: "share_of_total cannot be recomputed because the column total is zero.",
        };
      }
      const expectedPct = (ptr.value / total) * 100;
      const pctNumbers = numbers.filter((n) => n.isPercent);
      if (pctNumbers.length === 0 || !pctNumbers.some((n) => approxEqual(n.bare, expectedPct))) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: `${expectedPct.toFixed(2)}%`,
          found: pctNumbers[0]?.raw.trim() ?? "no percentage token",
          reason: `share_of_total ${pctNumbers[0]?.raw.trim() ?? "(missing)"} does not recompute to ${expectedPct.toFixed(2)}% from the result buffer.`,
        };
      }
      for (const number of numbers) {
        if (number.isPercent) continue;
        if (!numberGroundedInBuffer(number, insight.evidence, buffer)) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: "value present in query result cell",
            found: number.raw.trim(),
            reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
          };
        }
      }
      return null;
    }

    case "sum":
    case "mean": {
      const col = columnFromEvidenceOrBuffer(insight.evidence, buffer);
      if (!col) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: "evidence pointer naming a numeric query column",
          found: "none",
          reason: `${derivation} requires an evidence pointer naming a numeric query column.`,
        };
      }
      const values = columnNumericValues(buffer.rows, col);
      const computed =
        derivation === "sum"
          ? values.reduce((acc, v) => acc + v, 0)
          : values.reduce((acc, v) => acc + v, 0) / Math.max(values.length, 1);

      const truncIssue = checkTruncationGate(insight, buffer, truncated, computed);
      if (truncIssue) return { ...truncIssue, claimIndex };

      const nonPct = numbers.filter((n) => !n.isPercent && !n.isPercentagePoint);
      const matched = nonPct.find(
        (n) => approxEqual(n.bare, computed) || approxEqual(n.scaled, computed),
      );
      if (!matched) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: `${computed}`,
          found: nonPct.map((n) => n.raw.trim()).join(", ") || "none",
          reason: `${derivation} claim does not match recomputed ${derivation} (${computed}) within 1% tolerance.`,
        };
      }
      for (const number of numbers) {
        if (number === matched) continue;
        if (Number.isInteger(number.bare) && number.bare === values.length) continue;
        if (number.isPercent) {
          const direct = pointerValueMatches(
            number.bare,
            insight.evidence.map((p) => p.value),
          );
          if (!direct) {
            return {
              claimIndex,
              claim: insight.claim,
              expected: "direct percentage cell",
              found: number.raw.trim(),
              reason: `percentage ${number.raw.trim()} does not match cited evidence.`,
            };
          }
          continue;
        }
        if (!numberGroundedInBuffer(number, insight.evidence, buffer)) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: "value present in query result cell",
            found: number.raw.trim(),
            reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
          };
        }
      }
      return null;
    }

    case "rank": {
      const ptr = numericColumnPointer(insight.evidence, buffer);
      if (!ptr) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: "numeric evidence pointer from ranked column",
          found: "none",
          reason: "rank requires a numeric evidence pointer from the ranked column.",
        };
      }
      const asc = /(lowest|bottom|smallest|worst|thấp nhất|ít nhất|nhỏ nhất|cuối)/iu.test(
        insight.claim,
      );
      const values = columnNumericValues(buffer.rows, ptr.pointer.column);
      const eps = Math.max(Math.abs(ptr.value) * 1e-9, 1e-9);
      const expectedRank =
        1 +
        values.filter((v) => (asc ? v < ptr.value - eps : v > ptr.value + eps)).length;

      const truncIssue = checkTruncationGate(insight, buffer, truncated, expectedRank);
      if (truncIssue) return { ...truncIssue, claimIndex };

      const rankToken = numbers.find(
        (n) => !n.isPercent && !n.isPercentagePoint && Number.isInteger(n.bare) && n.bare === expectedRank,
      );
      if (!rankToken) {
        return {
          claimIndex,
          claim: insight.claim,
          expected: `rank ${expectedRank}`,
          found: numbers.map((n) => n.raw.trim()).join(", ") || "none",
          reason: `rank claim does not match recomputed rank ${expectedRank} in buffer.`,
        };
      }
      for (const number of numbers) {
        if (number === rankToken) continue;
        if (number.isPercent || !numberGroundedInBuffer(number, insight.evidence, buffer)) {
          return {
            claimIndex,
            claim: insight.claim,
            expected: "value present in query result cell",
            found: number.raw.trim(),
            reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
          };
        }
      }
      return null;
    }
  }
}

function findMatchingDeltaPair(
  claimedPct: number,
  evidence: EvidencePointer[],
): { curr: number; base: number } | null {
  const pair = resolveCurrBase(evidence);
  if (pair && pair.base.value !== 0) {
    const recomputed = ((pair.curr.value - pair.base.value) / Math.abs(pair.base.value)) * 100;
    if (approxEqual(Math.abs(claimedPct), Math.abs(recomputed))) {
      return { curr: pair.curr.value, base: pair.base.value };
    }
  }
  const values = numericPointersOf(evidence).map((item) => item.value);
  if (values.length < 2) return null;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = 0; j < values.length; j += 1) {
      if (i === j) continue;
      const base = values[j];
      if (base === 0) continue;
      const recomputed = ((values[i] - base) / Math.abs(base)) * 100;
      if (approxEqual(Math.abs(claimedPct), Math.abs(recomputed))) {
        return { curr: values[i], base };
      }
    }
  }
  return null;
}

export interface ClaimBuffer {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface VerifyClaimsOptions {
  eventIds?: readonly string[];
  truncated?: boolean;
}

export function verifyNumericClaims(
  insights: InsightClaim[],
  buffer: ClaimBuffer,
  opts: VerifyClaimsOptions = {},
): ClaimsVerification {
  const verified: InsightClaim[] = [];
  const stripped: StrippedClaim[] = [];
  const eventIds = opts.eventIds ?? [];
  const truncated = Boolean(opts.truncated);

  insights.forEach((insight, claimIndex) => {
    const numbers = extractClaimNumbers(insight.claim);
    const badPointer = insight.evidence.find(
      (pointer) => !pointerBufferValid(pointer, buffer),
    );
    if (badPointer !== undefined) {
      stripped.push({
        claimIndex,
        claim: insight.claim,
        expected: "valid cell present in query buffer",
        found: `{column: ${badPointer.column}, rowKey: ${badPointer.rowKey}, value: ${String(badPointer.value)}}`,
        reason: `evidence pointer {column: ${badPointer.column}, rowKey: ${badPointer.rowKey}} matches no query result cell.`,
      });
      return;
    }

    if (insight.derivation !== undefined) {
      const derivationFailure = verifyDeclaredDerivation(
        insight.derivation,
        insight,
        claimIndex,
        numbers,
        buffer,
        truncated,
      );
      if (derivationFailure) {
        stripped.push(derivationFailure);
        return;
      }
    } else {
      const truncIssue = checkTruncationGate(insight, buffer, truncated);
      if (truncIssue) {
        stripped.push({ ...truncIssue, claimIndex });
        return;
      }

      for (const number of numbers) {
        if (number.isPercentagePoint) {
          const directCell = pointerValueMatches(
            number.bare,
            insight.evidence.map((pointer) => pointer.value),
          );
          if (!directCell) {
            stripped.push({
              claimIndex,
              claim: insight.claim,
              expected: 'declared derivation "pp_change" for percentage-point delta',
              found: number.raw.trim(),
              reason: `percentage-point delta ${number.raw.trim()} requires derivation "pp_change" or a direct evidence cell.`,
            });
            return;
          }
          continue;
        }
        if (number.isPercent) {
          const directEvidenceMatch = pointerValueMatches(
            number.bare,
            insight.evidence.map((pointer) => pointer.value),
          );
          if (directEvidenceMatch) continue;
          const deltaPair = findMatchingDeltaPair(number.bare, insight.evidence);
          if (!deltaPair) {
            stripped.push({
              claimIndex,
              claim: insight.claim,
              expected: "percentage matching direct cell or ((curr - base) / |base|) * 100",
              found: number.raw.trim(),
              reason: `percentage ${number.raw.trim()} does not recompute from the cited evidence within 1% tolerance.`,
            });
            return;
          }
          const polErr = checkPolarity(
            insight.claim,
            deltaPair.curr,
            deltaPair.base,
            number.index,
            number.bare,
          );
          if (polErr) {
            stripped.push({ claimIndex, claim: insight.claim, ...polErr });
            return;
          }
          continue;
        }
        if (!numberGroundedInBuffer(number, insight.evidence, buffer)) {
          stripped.push({
            claimIndex,
            claim: insight.claim,
            expected: "value present in query result cell within 1% tolerance",
            found: number.raw.trim(),
            reason: `number ${number.raw.trim()} matches no query result cell within 1% tolerance.`,
          });
          return;
        }
      }

      // Check polarity for >= 2 numeric pointers in the same column even without an explicit percentage delta.
      const pair = resolveCurrBase(insight.evidence);
      if (pair && pair.curr.pointer.column === pair.base.pointer.column) {
        const polErr = checkPolarity(insight.claim, pair.curr.value, pair.base.value);
        if (polErr) {
          stripped.push({ claimIndex, claim: insight.claim, ...polErr });
          return;
        }
      }
    }

    if (!causalGrounded(insight.claim, insight.evidence, buffer.rows, buffer.columns, eventIds)) {
      stripped.push({
        claimIndex,
        claim: insight.claim,
        expected: "row-backed breakdown dimension or event:* citation",
        found: "ungrounded causal wording",
        reason: "causal language with no row-backed dimension or event:* citation; cause is unverified.",
      });
      return;
    }
    verified.push(insight);
  });

  return {
    verified,
    stripped,
    truncationCaveatRequired: truncated,
  };
}

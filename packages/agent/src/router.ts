import { DEFAULT_ROUTE_ID, RCA_UC_ID } from "./constants.js";

/**
 * Definitional and formula lookup queries belong to UC-01/UC-02 semantic
 * lookup fast-path (definition_lookup) and must never be routed to UC-05 RCA.
 */
const DEFINITION_LOOKUP_PATTERNS = [
  /\bđịnh\s*nghĩa\b/i,
  /\bcông\s*thức\b/i,
  /\bnghĩa\s+là\s+gì\b/i,
  /\bđược\s+tính\s+(thế\s+nào|như\s+thế\s+nào)\b/i,
  /\bdefinition\b/i,
  /\bformula\b/i,
  /\bmeaning\s+of\b/i,
  /\bhow\s+is\s+.*?\s+calculated\b/i,
];

/**
 * Patterns identifying diagnostic Root Cause Analysis (UC-05) questions.
 * Diagnostic questions require an explicit Why/Variance + directional change
 * (giảm, tăng, sụt giảm, biến động, drop, decrease, variance, etc.) or comparison (so với, vs).
 * Generic definition lookups, column aggregations (e.g. "lý do hủy đơn"), or bare explain/reasons
 * are excluded and fall back to DEFAULT_ROUTE_ID.
 */
const RCA_PATTERNS = [
  // Why/Tại sao/Vì sao with directional change or variance
  /\b(tại\s+sao|vì\s+sao)\b.*?\b(giảm|tăng|sụt|biến\s+động|rớt|thay\s+đổi|drop|decreas|increas|fall|fluctuat|lower|higher|down|up)/i,
  // Directional change + Why/Tại sao/Vì sao (e.g. "Doanh thu giảm vì sao?")
  /\b(giảm|tăng|sụt|biến\s+động)\b.*?\b(tại\s+sao|vì\s+sao)\b/i,
  // Nguyên nhân + variance / drop / spike / metric comparison
  /\bnguyên\s+nhân\b.*?\b(sụt\s*giảm|tăng\s*đột\s*biến|tăng\s*vọt|giảm|tăng|biến\s+động|drop|decreas|increas|variance)/i,
  // Explicit variance keywords (sụt giảm, tăng đột biến, tăng vọt, biến động)
  /\bsụt\s+giảm\b/i,
  /\btăng\s+đột\s+biến\b/i,
  /\btăng\s+vọt\b/i,
  /\bbiến\s+động\b/i,
  // Explicit comparative variance: giảm/tăng ... so với / vs / kỳ trước / tháng trước
  /\b(giảm|tăng)\b.*?\b(so\s+với|vs|kỳ\s+trước|tháng\s+trước|tuần\s+trước|cùng\s+kỳ|compared\s+to)\b/i,
  // English: Why + directional change / variance
  /\bwhy\b.*?\b(drop|decreas|increas|fall|grow|chang|declin|fluctuat|differ|lower|higher|down|up)/i,
  // English: Root cause / variance analysis
  /\broot\s*cause\b/i,
  /\bvariance\b/i,
  // English: Reason why / reason for + variance
  /\breasons?\s+(why|for)\b.*?\b(drop|decreas|increas|fall|declin|variance|down|up|lower|higher)/i,
  // Vietnamese: Lý do vì sao / lý do tại sao / lý do khiến + directional change
  /\blý\s+do\s+(vì\s+sao|tại\s+sao|khiến)\b/i,
  /\blý\s+do\b.*?\b(giảm|tăng|sụt|biến\s+động)\b/i,
];

/**
 * Classifies user questions into appropriate UC IDs.
 * If explicitUcId is provided and non-empty, respects it.
 * Otherwise:
 * 1. Definitional questions bypass RCA and route to DEFAULT_ROUTE_ID (UC-01/UC-02 definition_lookup).
 * 2. Questions matching Why/Variance with directional change/comparison route to RCA_UC_ID (UC-05).
 * 3. All other questions fall back to DEFAULT_ROUTE_ID.
 */
export function routeQuestionToUc(question: string, explicitUcId?: string): string {
  if (explicitUcId && explicitUcId.trim().length > 0) {
    return explicitUcId.trim();
  }
  const q = question.trim();
  for (const pattern of DEFINITION_LOOKUP_PATTERNS) {
    if (pattern.test(q)) {
      return DEFAULT_ROUTE_ID;
    }
  }
  for (const pattern of RCA_PATTERNS) {
    if (pattern.test(q)) {
      return RCA_UC_ID;
    }
  }
  return DEFAULT_ROUTE_ID;
}

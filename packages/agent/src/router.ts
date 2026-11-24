import { RCA_UC_ID, TEXT_TO_SQL_UC_ID } from "./constants.js";

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

const RCA_PATTERNS = [
  /\b(tại\s+sao|vì\s+sao)\b.*?\b(giảm|tăng|sụt|biến\s+động|rớt|thay\s+đổi|drop|decreas|increas|fall|fluctuat|lower|higher|down|up)/i,
  /\b(giảm|tăng|sụt|biến\s+động)\b.*?\b(tại\s+sao|vì\s+sao)\b/i,
  /\bnguyên\s+nhân\b.*?\b(sụt\s*giảm|tăng\s*đột\s*biến|tăng\s*vọt|giảm|tăng|biến\s+động|drop|decreas|increas|variance)/i,
  /\bsụt\s+giảm\b/i,
  /\btăng\s+đột\s+biến\b/i,
  /\btăng\s+vọt\b/i,
  /\bbiến\s+động\b/i,
  /\b(giảm|tăng)\b.*?\b(so\s+với|vs|kỳ\s+trước|tháng\s+trước|tuần\s+trước|cùng\s+kỳ|compared\s+to)\b/i,
  /\bwhy\b.*?\b(drop|decreas|increas|fall|grow|chang|declin|fluctuat|differ|lower|higher|down|up)/i,
  /\broot\s*cause\b/i,
  /\bvariance\b/i,
  /\breasons?\s+(why|for)\b.*?\b(drop|decreas|increas|fall|declin|variance|down|up|lower|higher)/i,
  /\blý\s+do\s+(vì\s+sao|tại\s+sao|khiến)\b/i,
  /\blý\s+do\b.*?\b(giảm|tăng|sụt|biến\s+động)\b/i,
];

export function routeQuestionToUc(question: string, explicitUcId?: string): string {
  if (explicitUcId && explicitUcId.trim().length > 0) {
    return explicitUcId.trim();
  }
  const q = question.trim();
  // Check definitions first so overlapping RCA patterns cannot capture them.
  for (const pattern of DEFINITION_LOOKUP_PATTERNS) {
    if (pattern.test(q)) {
      return TEXT_TO_SQL_UC_ID;
    }
  }
  for (const pattern of RCA_PATTERNS) {
    if (pattern.test(q)) {
      return RCA_UC_ID;
    }
  }
  return TEXT_TO_SQL_UC_ID;
}

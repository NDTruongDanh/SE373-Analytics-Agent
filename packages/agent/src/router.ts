import { DEFAULT_ROUTE_ID, RCA_UC_ID } from "./constants.js";

const RCA_PATTERNS = [
  /\btại\s+sao\b/i,
  /\bvì\s+sao\b/i,
  /\bnguyên\s+nhân\b/i,
  /\blý\s+do\b/i,
  /\bgiải\s+thích\b/i,
  /\bsụt\s+giảm\b/i,
  /\btăng\s+đột\s+biến\b/i,
  /\bbiến\s+động\b/i,
  /\bgiảm\b.*?\bso\s+với\b/i,
  /\btăng\b.*?\bso\s+với\b/i,
  /\bwhy\b/i,
  /\broot\s*cause\b/i,
  /\bvariance\b/i,
  /\breason\b/i,
];

/**
 * Classifies user questions into appropriate UC IDs.
 * If explicitUcId is provided and non-empty, respects it.
 * Otherwise, inspects question keywords for RCA / Why / Variance patterns.
 */
export function routeQuestionToUc(question: string, explicitUcId?: string): string {
  if (explicitUcId && explicitUcId.trim().length > 0) {
    return explicitUcId.trim();
  }
  const q = question.trim();
  for (const pattern of RCA_PATTERNS) {
    if (pattern.test(q)) {
      return RCA_UC_ID;
    }
  }
  return DEFAULT_ROUTE_ID;
}

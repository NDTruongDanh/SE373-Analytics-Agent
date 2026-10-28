// Shared PII redactor (POL-04): pure phone/email masking used by result
// rows, trace/audit payload writers, and the mcp-server sanitizeError
// choke-point. Patterns are locked to the gateway-research §4 set, derived
// from the Faker `vi` phone formats: mobile, landline, international +84,
// plus email. No DB or network I/O.
export const MASKED_PHONE = "[MASKED_PHONE]";
export const MASKED_EMAIL = "[MASKED_EMAIL]";

// Mobile: 03/05/07/08/09 prefixes, 10 digits total, spaced and compact
// forms (e.g. `0901 234 567`, `0901234567`, `032 123 4567`). Separators may
// sit between any digits, so both 4-3-3 and 3-3-4 groupings match.
const MOBILE_PATTERN = /\b0(?:3|5|7|8|9)(?:[\s.\-]*\d){8}\b/g;
// Landline: 02X prefixes with 10-12 digits total
// (e.g. `0285 8212 0590`, `024 0590 1799`, compact `028582120590`).
const LANDLINE_PATTERN = /\b02\d(?:[\s.\-]*\d){7,9}\b/g;
// International: +84 with 8-9 subscriber digits and optional separators
// (e.g. `+84901234567`, `+84 901 234 567`).
const INTL_PATTERN = /\+84(?:[\s.\-]*\d){8,9}\b/g;
// Email: standard addr-spec shape.
const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export type RedactResult = { redacted: string; hit: boolean };

// Mask every phone/email occurrence in text. Returns the redacted text plus
// a hit flag (true when at least one replacement fired).
export function redactPII(text: string): RedactResult {
  let redacted = text;
  redacted = redacted.replace(MOBILE_PATTERN, MASKED_PHONE);
  redacted = redacted.replace(LANDLINE_PATTERN, MASKED_PHONE);
  redacted = redacted.replace(INTL_PATTERN, MASKED_PHONE);
  redacted = redacted.replace(EMAIL_PATTERN, MASKED_EMAIL);
  return { redacted, hit: redacted !== text };
}

export type RedactRowResult = {
  row: Record<string, unknown>;
  hit: boolean;
};

// Walk each cell of a result row: string cells are scanned and masked in
// place, non-string cells pass through untouched. Returns the same (mutated)
// row plus a row-level hit flag.
export function redactRow(row: Record<string, unknown>): RedactRowResult {
  let hit = false;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (typeof value !== "string") continue;
    const { redacted, hit: cellHit } = redactPII(value);
    if (cellHit) {
      row[key] = redacted;
      hit = true;
    }
  }
  return { row, hit };
}

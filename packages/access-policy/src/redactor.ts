import { MASKED_EMAIL, MASKED_PHONE } from "./constants.js";

export { MASKED_EMAIL, MASKED_PHONE };

// Rejects word/digit prefixes and decimal fractions (e.g. 0.0912345678, where \b would match after '.') while matching after punctuation.
const PHONE_START = String.raw`(?<!\w|\d[.,])`;
const MOBILE_PATTERN = new RegExp(
  String.raw`${PHONE_START}0(?:3|5|7|8|9)(?:[\s.\-]*\d){8}\b`,
  "g",
);
const LANDLINE_PATTERN = new RegExp(
  String.raw`${PHONE_START}02\d(?:[\s.\-]*\d){7,9}\b`,
  "g",
);
const INTL_PATTERN = /\+84(?:[\s.\-]*\d){8,9}\b/g;
const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export type RedactResult = { redacted: string; hit: boolean };

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

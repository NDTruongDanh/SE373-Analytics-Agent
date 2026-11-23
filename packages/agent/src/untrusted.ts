/**
 * Escape delimiter-breaking characters (`&`, `<`, `>`) on untrusted text and
 * serialized database cells before wrapping in `<untrusted_data>` or other
 * XML-like prompt delimiters.
 *
 * `JSON.stringify` alone does not escape `<` or `>`, so a literal
 * `</untrusted_data>` inside a database row or user input could otherwise
 * close the data block early. `&` is escaped first so introduced entities are
 * never double-escaped.
 */
export function escapeUntrustedText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Serialize any untrusted value with `JSON.stringify` and escape `&`, `<`, `>`
 * so it can safely appear inside `<untrusted_data>` or `<question>` tags.
 */
export function serializeUntrusted(value: unknown): string {
  return escapeUntrustedText(JSON.stringify(value) ?? "null");
}

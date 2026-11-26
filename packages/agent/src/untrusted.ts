/**
 * JSON.stringify leaves `<` and `>` unescaped, allowing raw `</untrusted_data>` to close prompt delimiters early;
 * `&` is escaped first so introduced entities are never double-escaped.
 */
export function escapeUntrustedText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function serializeUntrusted(value: unknown): string {
  return escapeUntrustedText(JSON.stringify(value) ?? "null");
}

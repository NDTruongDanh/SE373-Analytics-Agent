// Sensitive-columns loader (POL-01, D-06): strict zod schema plus a pure
// YAML-text parser plus a thin filesystem wrapper. Invalid config throws
// fail-fast so boot fails closed — an unusable policy can never be built.
//
// Dependency note (D-07, zero-new-deps): this module parses YAML with a
// minimal built-in subset parser (mappings, sequences, scalars, comments)
// instead of the `yaml` npm package, because this plan installs zero
// packages and `yaml` is not a declared dependency of @se373/access-policy.
// The parser preserves unknown keys and scalar types verbatim so the strict
// zod schema below stays the single validation authority: wrong version
// literals, missing columns, empty names and extra keys all throw.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as z from "zod";

export const SensitiveColumnsSchema = z.strictObject({
  version: z.literal(1),
  columns: z.array(
    z.strictObject({
      table: z.string().min(1),
      column: z.string().min(1),
    }),
  ),
});

export type SensitiveColumns = z.infer<typeof SensitiveColumnsSchema>;

// Default sensitive set: the v1 reference set (customers contact fields plus
// the employees compensation field), with exact table/column names matching
// the 01-04 catalog once merged. Used by ColumnScopePolicy when no explicit
// list is passed; the yaml FILE itself lands in 01-08
// (policies/sensitive_columns.yaml) — never created here.
export const DEFAULT_SENSITIVE_COLUMNS: SensitiveColumns = {
  version: 1,
  columns: [
    { table: "customers", column: "phone" },
    { table: "customers", column: "email" },
    { table: "customers", column: "address" },
    { table: "employees", column: "salary" },
  ],
};

// Repo-root policies file, resolved from this module's location so the
// default works regardless of the caller's cwd (src and dist layouts both
// sit two levels below the repo root).
export const DEFAULT_SENSITIVE_COLUMNS_PATH = fileURLToPath(
  new URL("../../../policies/sensitive_columns.yaml", import.meta.url),
);

type YamlScalar = string | number | boolean | null;
type YamlNode = YamlScalar | YamlNode[] | { [key: string]: YamlNode };

function fail(reason: string): never {
  throw new Error(`Invalid sensitive_columns YAML: ${reason}`);
}

function isDashLine(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

// Strip a `#` comment that starts the line or follows whitespace, tracking
// single/double quotes so `#` inside a value survives.
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw: string): YamlScalar {
  const text = raw.trim();
  if (
    (text.startsWith('"') &&
      text.length >= 2 &&
      text.endsWith('"')) ||
    (text.startsWith("'") && text.length >= 2 && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text === "" || text === "~" || /^(null|Null|NULL)$/.test(text)) {
    return null;
  }
  if (/^(true|True|TRUE|false|False|FALSE)$/.test(text)) {
    return text[0] === "t" || text[0] === "T";
  }
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  return text;
}

function splitMappingRow(text: string): { key: string; value: string } {
  const colon = text.indexOf(":");
  if (colon < 0) fail(`expected "key: value", got ${JSON.stringify(text)}`);
  const key = parseScalar(text.slice(0, colon).trim());
  if (typeof key !== "string" || key.length === 0) {
    fail(`empty mapping key in ${JSON.stringify(text)}`);
  }
  return { key, value: text.slice(colon + 1).trim() };
}

type Line = { indent: number; text: string };

function parseBlock(lines: Line[], i: number): [YamlNode, number] {
  const first = lines[i] as Line;
  if (isDashLine(first.text)) return parseSequence(lines, i, first.indent);
  return parseMapping(lines, i, first.indent);
}

function parseMapping(
  lines: Line[],
  i: number,
  indent: number,
): [{ [key: string]: YamlNode }, number] {
  const map: { [key: string]: YamlNode } = {};
  while (
    i < lines.length &&
    (lines[i] as Line).indent === indent &&
    !isDashLine((lines[i] as Line).text)
  ) {
    const { key, value } = splitMappingRow((lines[i] as Line).text);
    if (Object.hasOwn(map, key)) fail(`duplicate key ${JSON.stringify(key)}`);
    i++;
    if (value !== "") {
      map[key] = parseScalar(value);
    } else if (i < lines.length && (lines[i] as Line).indent > indent) {
      const [node, next] = parseBlock(lines, i);
      map[key] = node;
      i = next;
    } else {
      map[key] = null;
    }
  }
  return [map, i];
}

function parseSequence(lines: Line[], i: number, indent: number): [YamlNode[], number] {
  const items: YamlNode[] = [];
  while (
    i < lines.length &&
    (lines[i] as Line).indent === indent &&
    isDashLine((lines[i] as Line).text)
  ) {
    const rest = (lines[i] as Line).text.slice(1).trim();
    i++;
    if (rest === "") {
      if (i < lines.length && (lines[i] as Line).indent > indent) {
        const [node, next] = parseBlock(lines, i);
        items.push(node);
        i = next;
      } else {
        items.push(null);
      }
      continue;
    }
    if (rest.includes(":")) {
      // Inline mapping fragment after the dash (e.g. `- table: customers`).
      // Parse its first row, then consume deeper-indented continuation
      // rows into the same mapping.
      const map: { [key: string]: YamlNode } = {};
      const first = splitMappingRow(rest);
      map[first.key] = first.value !== "" ? parseScalar(first.value) : null;
      let j = i;
      while (
        j < lines.length &&
        (lines[j] as Line).indent > indent &&
        !isDashLine((lines[j] as Line).text)
      ) {
        const { key, value } = splitMappingRow((lines[j] as Line).text);
        if (Object.hasOwn(map, key)) {
          fail(`duplicate key ${JSON.stringify(key)}`);
        }
        j++;
        if (value !== "") {
          map[key] = parseScalar(value);
        } else if (j < lines.length && (lines[j] as Line).indent > (lines[j - 1] as Line).indent) {
          const [node, nextInner] = parseBlock(lines, j);
          map[key] = node;
          j = nextInner;
        } else {
          map[key] = null;
        }
      }
      i = j;
      items.push(map);
      continue;
    }
    items.push(parseScalar(rest));
  }
  return [items, i];
}

// Pure function: YAML text in, validated config out. Throws on malformed
// YAML or any schema violation (missing version, wrong literal, empty
// table/column, extra keys via strictObject).
export function loadSensitiveColumns(yamlText: string): SensitiveColumns {
  const lines: Line[] = [];
  for (const raw of yamlText.split(/\r?\n/)) {
    if (raw.includes("\t")) fail("tabs are not allowed for indentation");
    const stripped = stripComment(raw);
    if (stripped.trim() === "") continue;
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: stripped.trim() });
  }
  if (lines.length === 0) fail("empty document");
  const [parsed, next] = parseBlock(lines, 0);
  if (next !== lines.length) {
    fail("unexpected trailing content after the top-level mapping");
  }
  return SensitiveColumnsSchema.parse(parsed);
}

// IO wrapper: reads the file, then delegates to the pure loader. The env
// override exists for tests and relocated deployments; the explicit path
// argument beats both.
export function loadSensitiveColumnsFile(
  path: string = DEFAULT_SENSITIVE_COLUMNS_PATH,
  override?: string,
): SensitiveColumns {
  const resolved = override ?? process.env["SENSITIVE_COLUMNS_PATH"] ?? path;
  return loadSensitiveColumns(readFileSync(resolved, "utf8"));
}

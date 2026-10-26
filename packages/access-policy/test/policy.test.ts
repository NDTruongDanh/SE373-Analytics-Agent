import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_COLUMNS,
  loadSensitiveColumns,
  loadSensitiveColumnsFile,
} from "../src/sensitive-columns.js";
import { redactPII, redactRow } from "../src/redactor.js";

const VALID_YAML = `version: 1
columns:
  - table: customers
    column: phone
  - table: customers
    column: email
  - table: customers
    column: address
  - table: employees
    column: salary
`;

describe("loadSensitiveColumns", () => {
  it("parses the valid fixture with all four reference columns", () => {
    const parsed = loadSensitiveColumns(VALID_YAML);
    expect(parsed.version).toBe(1);
    expect(parsed.columns).toHaveLength(4);
    expect(parsed.columns).toContainEqual({
      table: "customers",
      column: "phone",
    });
    expect(parsed.columns).toContainEqual({
      table: "employees",
      column: "salary",
    });
  });

  it("exposes the v1 reference set as the default list", () => {
    expect(DEFAULT_SENSITIVE_COLUMNS.version).toBe(1);
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "customers",
      column: "phone",
    });
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "customers",
      column: "email",
    });
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "customers",
      column: "address",
    });
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "employees",
      column: "salary",
    });
  });

  it("rejects a missing version", () => {
    expect(() =>
      loadSensitiveColumns("columns:\n  - table: customers\n    column: phone\n"),
    ).toThrow();
  });

  it("rejects a wrong version literal", () => {
    expect(() =>
      loadSensitiveColumns(
        "version: 2\ncolumns:\n  - table: customers\n    column: phone\n",
      ),
    ).toThrow();
  });

  it("rejects a missing columns array", () => {
    expect(() => loadSensitiveColumns("version: 1\n")).toThrow();
  });

  it("rejects an empty table name", () => {
    expect(() =>
      loadSensitiveColumns(
        'version: 1\ncolumns:\n  - table: ""\n    column: phone\n',
      ),
    ).toThrow();
  });

  it("rejects an empty column name", () => {
    expect(() =>
      loadSensitiveColumns(
        "version: 1\ncolumns:\n  - table: customers\n    column: ''\n",
      ),
    ).toThrow();
  });

  it("rejects extra keys via strictness", () => {
    expect(() =>
      loadSensitiveColumns(`${VALID_YAML}owner: someone\n`),
    ).toThrow();
    expect(() =>
      loadSensitiveColumns(
        "version: 1\ncolumns:\n  - table: customers\n    column: phone\n    scope: pii\n",
      ),
    ).toThrow();
  });

  it("rejects malformed YAML", () => {
    expect(() => loadSensitiveColumns("version: [1\ncolumns: :\n")).toThrow();
    expect(() => loadSensitiveColumns("")).toThrow();
    expect(() => loadSensitiveColumns("version: 1\n\tcolumns: []\n")).toThrow();
  });

  it("loads through the file wrapper with an explicit override path", () => {
    const dir = mkdtempSync(join(tmpdir(), "sens-"));
    const file = join(dir, "sensitive_columns.yaml");
    writeFileSync(file, VALID_YAML);
    const parsed = loadSensitiveColumnsFile(file);
    expect(parsed.columns).toHaveLength(4);
    const viaEnv = loadSensitiveColumnsFile("/nonexistent.yaml", file);
    expect(viaEnv.columns).toHaveLength(4);
  });
});

describe("redactPII", () => {
  const phones = [
    "0901 234 567", // mobile spaced
    "0901234567", // mobile compact
    "032 123 4567", // mobile 03 spaced
    "0587654321", // mobile 05 compact
    "0285 8212 0590", // landline spaced
    "028582120590", // landline compact
    "024 0590 1799", // national 024 spaced
    "+84901234567", // international compact
    "+84 901 234 567", // international spaced
  ];

  it.each(phones)("masks phone shape %s", (phone) => {
    const { redacted, hit } = redactPII(`lien he ${phone} nhe`);
    expect(hit).toBe(true);
    expect(redacted).toContain("[MASKED_PHONE]");
    expect(redacted).not.toContain(phone);
  });

  it("masks dotted and dashed phone separators", () => {
    for (const phone of ["0901.234.567", "0901-234-567"]) {
      const { redacted, hit } = redactPII(phone);
      expect(hit).toBe(true);
      expect(redacted).not.toContain(phone);
      expect(redacted).toContain("[MASKED_PHONE]");
    }
  });

  it("masks email addresses", () => {
    const { redacted, hit } = redactPII("mail lan@example.com di");
    expect(hit).toBe(true);
    expect(redacted).toContain("[MASKED_EMAIL]");
    expect(redacted).not.toContain("lan@example.com");
  });

  it("masks phones and emails together in one pass", () => {
    const { redacted, hit } = redactPII("0901 234 567 lan@example.com");
    expect(hit).toBe(true);
    expect(redacted).toContain("[MASKED_PHONE]");
    expect(redacted).toContain("[MASKED_EMAIL]");
    expect(redacted).not.toContain("0901");
    expect(redacted).not.toContain("lan@example.com");
  });

  it("leaves clean text byte-identical with hit false", () => {
    const clean = "don hang 123 da giao thanh cong";
    const { redacted, hit } = redactPII(clean);
    expect(hit).toBe(false);
    expect(redacted).toBe(clean);
  });
});

describe("redactRow", () => {
  it("masks string cells in place and reports a row-level hit", () => {
    const row: Record<string, unknown> = {
      id: 7,
      name: "Nguyen Van A",
      phone: "0901 234 567",
      email: "a@example.com",
      total: 120.5,
      active: true,
      meta: null,
    };
    const { row: out, hit } = redactRow(row);
    expect(hit).toBe(true);
    expect(out).toBe(row);
    expect(out["phone"]).toBe("[MASKED_PHONE]");
    expect(out["email"]).toBe("[MASKED_EMAIL]");
    expect(out["id"]).toBe(7);
    expect(out["name"]).toBe("Nguyen Van A");
    expect(out["total"]).toBe(120.5);
    expect(out["active"]).toBe(true);
    expect(out["meta"]).toBeNull();
  });

  it("passes non-string cells through untouched with hit false", () => {
    const row: Record<string, unknown> = { id: 1, total: 9.99 };
    const { row: out, hit } = redactRow(row);
    expect(hit).toBe(false);
    expect(out).toEqual({ id: 1, total: 9.99 });
  });
});

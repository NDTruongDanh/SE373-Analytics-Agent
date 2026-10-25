import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_COLUMNS_PATH,
  loadSensitiveColumns,
  loadSensitiveColumnsFile,
} from "../src/sensitive-columns.js";

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
  it("parses the valid fixture with all four UC-09 columns", () => {
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

  it("rejects an empty table name", () => {
    expect(() =>
      loadSensitiveColumns(
        'version: 1\ncolumns:\n  - table: ""\n    column: phone\n',
      ),
    ).toThrow();
  });

  it("rejects extra keys via strictness", () => {
    // Extra top-level key.
    expect(() =>
      loadSensitiveColumns(`${VALID_YAML}owner: someone\n`),
    ).toThrow();
    // Extra key inside an entry.
    expect(() =>
      loadSensitiveColumns(
        "version: 1\ncolumns:\n  - table: customers\n    column: phone\n    scope: pii\n",
      ),
    ).toThrow();
  });

  it("rejects malformed YAML", () => {
    expect(() => loadSensitiveColumns("version: [1\ncolumns: :\n")).toThrow();
  });
});

describe("loadSensitiveColumnsFile", () => {
  it("loads the repo policies file through the default path", () => {
    const parsed = loadSensitiveColumnsFile();
    expect(parsed.version).toBe(1);
    expect(parsed.columns).toHaveLength(4);
    expect(DEFAULT_SENSITIVE_COLUMNS_PATH).toMatch(
      /policies.sensitive_columns\.yaml$/,
    );
  });

  it("loads an explicit file and honors the env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensitive-columns-"));
    const file = join(dir, "custom.yaml");
    writeFileSync(
      file,
      "version: 1\ncolumns:\n  - table: employees\n    column: salary\n",
    );
    expect(loadSensitiveColumnsFile(file).columns).toEqual([
      { table: "employees", column: "salary" },
    ]);

    const previous = process.env["SENSITIVE_COLUMNS_PATH"];
    process.env["SENSITIVE_COLUMNS_PATH"] = file;
    try {
      // Explicit default path is ignored while the env override is set.
      expect(
        loadSensitiveColumnsFile("/nonexistent/sensitive_columns.yaml").columns,
      ).toEqual([{ table: "employees", column: "salary" }]);
    } finally {
      if (previous === undefined) {
        delete process.env["SENSITIVE_COLUMNS_PATH"];
      } else {
        process.env["SENSITIVE_COLUMNS_PATH"] = previous;
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  DescribeTableInputSchema,
  DescribeTableOutputSchema,
  ListTablesInputSchema,
  ListTablesOutputSchema,
} from "../src/tools.js";

describe("list_tables and describe_table schemas", () => {
  it("parses a valid describe_table input", () => {
    const parsed = DescribeTableInputSchema.parse({ table: "ghost_table_xyz" });
    expect(parsed.table).toBe("ghost_table_xyz");
  });

  it("rejects a table name longer than 128 chars", () => {
    expect(() =>
      DescribeTableInputSchema.parse({ table: "t".repeat(129) }),
    ).toThrow();
  });

  it("ListTablesOutput accepts table entries and DescribeTableOutput keeps the sensitive flag on a column", () => {
    const parsed = ListTablesOutputSchema.parse({
      tables: [{ name: "customers", schema: "public" }],
    });
    expect(parsed.tables).toHaveLength(1);
    const described = DescribeTableOutputSchema.parse({
      table: "customers",
      columns: [
        { name: "phone", type: "text", nullable: true, sensitive: true },
      ],
    });
    expect(described.columns[0]?.sensitive).toBe(true);
    expect(described.primaryKey).toEqual([]);
    expect(described.foreignKeys).toEqual([]);
    expect(ListTablesInputSchema.parse({})).toEqual({});
  });

  it("rejects unknown keys on ListTablesInput", () => {
    expect(() => ListTablesInputSchema.parse({ scope: "data:read" })).toThrow();
  });
});

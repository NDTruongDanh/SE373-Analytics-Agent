import { describe, expect, it } from "vitest";
import { SchemaCatalogSchema } from "../src/catalog.js";

describe("SchemaCatalog schema", () => {
  it("parses a valid catalog with tables and columns", () => {
    const parsed = SchemaCatalogSchema.parse({
      tables: {
        customers: ["id", "name", "phone"],
        orders: ["id", "customer_id", "total"],
      },
    });
    expect(parsed.tables["customers"]).toEqual(["id", "name", "phone"]);
  });

  it("parses an empty tables record", () => {
    const parsed = SchemaCatalogSchema.parse({ tables: {} });
    expect(parsed.tables).toEqual({});
  });

  it("rejects a missing tables key", () => {
    expect(() => SchemaCatalogSchema.parse({})).toThrow();
  });

  it("rejects a non-array column list", () => {
    expect(() =>
      SchemaCatalogSchema.parse({ tables: { orders: "id,total" } }),
    ).toThrow();
  });

  it("rejects a non-string column entry", () => {
    expect(() =>
      SchemaCatalogSchema.parse({ tables: { orders: ["id", 42] } }),
    ).toThrow();
  });
});

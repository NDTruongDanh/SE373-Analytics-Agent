// Schema catalog builder (MCP-01): constructs the frozen CONT-08
// array-of-tables SchemaCatalog at boot from information_schema columns via
// agent_ro, merged with the sensitive flags from sensitive_columns.yaml. A
// documented LARGE_TABLES constant marks tables that need a filter before a
// full scan (a later wave may promote this to config). Boot fails closed:
// an empty catalog throws so the server never serves nothing as something.
// Primary keys and foreign keys ride alongside (describe_table shape) but
// are not part of the frozen catalog zod shape.
import type { SchemaCatalog } from "@shared/contracts";
import type { SensitiveColumns } from "@shared/access-policy";

export const LARGE_TABLES: readonly string[] = ["order_items"];

export interface ForeignKeyRef {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface BuiltCatalog {
  catalog: SchemaCatalog;
  primaryKeys: Map<string, string[]>;
  foreignKeys: Map<string, ForeignKeyRef[]>;
}

export interface CatalogRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export interface ConstraintRow {
  table_name: string;
  column_name: string;
  constraint_type: "PRIMARY KEY" | "FOREIGN KEY";
  references_table: string | null;
  references_column: string | null;
  ordinal_position: number;
}

export interface CatalogSource {
  tables: string[];
  columns: CatalogRow[];
  constraints: ConstraintRow[];
}

export async function fetchCatalogSource(
  query: (
    text: string,
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<CatalogSource> {
  const tablesResult = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  const columnsResult = await query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`,
  );
  const constraintsResult = await query(
    `SELECT tc.table_name, kcu.column_name, tc.constraint_type,
            ccu.table_name AS references_table, ccu.column_name AS references_column,
            kcu.ordinal_position
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     LEFT JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
     ORDER BY tc.table_name, kcu.ordinal_position`,
  );
  return {
    tables: tablesResult.rows.map((row) => String(row["table_name"])),
    columns: (columnsResult.rows as unknown as CatalogRow[]),
    constraints: (constraintsResult.rows as unknown as ConstraintRow[]),
  };
}

export function buildCatalog(
  source: CatalogSource,
  sensitive: SensitiveColumns,
): BuiltCatalog {
  if (source.tables.length === 0) {
    throw new Error("refusing to serve an empty schema catalog");
  }
  const sensitiveKeys = new Set(
    sensitive.columns.map(
      (entry) => `${entry.table.toLowerCase()}.${entry.column.toLowerCase()}`,
    ),
  );
  const largeKeys = new Set(LARGE_TABLES.map((name) => name.toLowerCase()));
  const byTable = new Map<string, CatalogRow[]>();
  for (const column of source.columns) {
    const list = byTable.get(column.table_name) ?? [];
    list.push(column);
    byTable.set(column.table_name, list);
  }
  const primaryKeys = new Map<string, string[]>();
  const foreignKeys = new Map<string, ForeignKeyRef[]>();
  for (const constraint of source.constraints) {
    if (constraint.constraint_type === "PRIMARY KEY") {
      const list = primaryKeys.get(constraint.table_name) ?? [];
      list.push(constraint.column_name);
      primaryKeys.set(constraint.table_name, list);
    } else if (
      constraint.references_table !== null &&
      constraint.references_column !== null
    ) {
      const list = foreignKeys.get(constraint.table_name) ?? [];
      list.push({
        column: constraint.column_name,
        referencesTable: constraint.references_table,
        referencesColumn: constraint.references_column,
      });
      foreignKeys.set(constraint.table_name, list);
    }
  }
  return {
    catalog: {
      tables: source.tables.map((name) => ({
        name,
        schema: "public",
        columns: (byTable.get(name) ?? []).map((column) => ({
          name: column.column_name,
          type: column.data_type,
          nullable: column.is_nullable === "YES",
          sensitive: sensitiveKeys.has(
            `${name.toLowerCase()}.${column.column_name.toLowerCase()}`,
          ),
          large: largeKeys.has(name.toLowerCase()),
        })),
      })),
    },
    primaryKeys,
    foreignKeys,
  };
}

/** Case-insensitive table lookup; undefined when the table is unknown. */
export function findTable(
  catalog: BuiltCatalog,
  name: string,
): BuiltCatalog["catalog"]["tables"][number] | undefined {
  for (const table of catalog.catalog.tables) {
    if (table.name === name) return table;
  }
  const lowered = name.toLowerCase();
  for (const table of catalog.catalog.tables) {
    if (table.name.toLowerCase() === lowered) return table;
  }
  return undefined;
}

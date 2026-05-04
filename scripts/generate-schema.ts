#!/usr/bin/env tsx
/**
 * generate-schema.ts
 *
 * Reads the live Postgres schema + schema-config.json and writes src/lib/schema.ts.
 * Run via:  npm run generate-schema
 * Or as part of app-sync before every build.
 *
 * Requires: JOJODB_DATABASE_URL in environment (or .env in project root)
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Load .env if present ─────────────────────────────────────────────────────
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const DATABASE_URL =
  process.env.JOJODB_DATABASE_URL ?? "postgresql://localhost/pipeline";

// ── Load schema-config.json ──────────────────────────────────────────────────
const configPath = path.join(ROOT, "schema-config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SchemaConfig;

interface SchemaConfig {
  includeTables: string[];
  tables: Record<string, TableConfig>;
  columnLabels: Record<string, string>;
  columnOverrides: Record<string, Partial<ColumnOverride>>;
}

interface TableConfig {
  label: string;
  statusField: string;
  kanbanEnum: string;
  cardFields: string[];
  filters: Array<{ field: string; enumKey: string }>;
}

interface ColumnOverride {
  type: string;
  editable: boolean;
  references: { table: string; displayField: string };
}

// ── Postgres type → ColumnType mapping ───────────────────────────────────────
function pgTypeToColumnType(pgType: string, udtName: string | null): string {
  if (pgType === "USER-DEFINED" && udtName) return "enum";
  switch (pgType) {
    case "integer":
    case "bigint":
    case "smallint":
      return "int";
    case "date":
      return "date";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "text";
    default:
      return "text";
  }
}

// ── Column label from config or auto-generated ───────────────────────────────
function labelFor(columnKey: string): string {
  if (config.columnLabels[columnKey]) return config.columnLabels[columnKey];
  return columnKey
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// ── Apply column overrides (wildcard *.key or table.key) ─────────────────────
function applyOverrides(
  table: string,
  col: string,
  base: Record<string, unknown>
): Record<string, unknown> {
  const wildcard = config.columnOverrides[`*.${col}`] ?? {};
  const specific = config.columnOverrides[`${table}.${col}`] ?? {};
  return { ...base, ...wildcard, ...specific };
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    // ── Fetch all ENUMs ──────────────────────────────────────────────────────
    const enumResult = await client.query<{
      enum_name: string;
      enum_value: string;
    }>(`
      SELECT t.typname AS enum_name, e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder;
    `);

    const enums: Record<string, string[]> = {};
    for (const row of enumResult.rows) {
      if (!enums[row.enum_name]) enums[row.enum_name] = [];
      enums[row.enum_name].push(row.enum_value);
    }

    // ── Fetch columns for each included table ────────────────────────────────
    const tables: Record<string, unknown> = {};

    for (const tableName of config.includeTables) {
      const tableConfig = config.tables[tableName];
      if (!tableConfig) {
        console.warn(
          `Warning: '${tableName}' is in includeTables but missing from tables config — skipping`
        );
        continue;
      }

      const colResult = await client.query<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `
        SELECT column_name, data_type, udt_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
        `,
        [tableName]
      );

      const columns = colResult.rows.map((col) => {
        const baseType = pgTypeToColumnType(col.data_type, col.udt_name);
        const isRequired =
          col.is_nullable === "NO" &&
          !col.column_default &&
          col.column_name !== "id";

        const base: Record<string, unknown> = {
          key: col.column_name,
          label: labelFor(col.column_name),
          type: baseType,
          editable: col.column_name !== "id",
          ...(baseType === "enum" ? { enumKey: col.udt_name } : {}),
          ...(isRequired ? { required: true } : {}),
        };

        const result = applyOverrides(tableName, col.column_name, base);

        // Re-attach enumKey if it remained an enum after overrides
        if (baseType === "enum" && result.type === "enum") {
          result.enumKey = col.udt_name;
        }

        return result;
      });

      tables[tableName] = {
        label: tableConfig.label,
        statusField: tableConfig.statusField,
        cardFields: tableConfig.cardFields,
        filters: tableConfig.filters,
        columns,
      };
    }

    // ── Serialise to TypeScript ──────────────────────────────────────────────
    const tableKeys = config.includeTables.map((t) => `"${t}"`).join(" | ");

    const output = `// AUTO-GENERATED by scripts/generate-schema.ts — do not edit by hand.
// Run \`npm run generate-schema\` or \`app-sync\` to regenerate after schema changes.

export type TableKey = ${tableKeys};

export type ColumnType = "text" | "date" | "enum" | "int" | "url" | "path" | "fk";

export type ColumnConfig = {
  key: string;
  label: string;
  type: ColumnType;
  editable: boolean;
  required?: boolean;
  enumKey?: string;
  references?: { table: string; displayField: string };
};

export const ENUMS: Record<string, readonly string[]> = ${JSON.stringify(enums, null, 2)} as const;

export const TABLES: Record<
  TableKey,
  {
    label: string;
    statusField: string;
    cardFields: string[];
    filters: Array<{ field: string; enumKey: string }>;
    columns: ColumnConfig[];
  }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
> = ${JSON.stringify(tables, null, 2)} as any;
`;

    const outPath = path.join(ROOT, "src", "lib", "schema.ts");
    fs.writeFileSync(outPath, output, "utf8");

    console.log(`✓ schema.ts written to src/lib/schema.ts`);
    console.log(`  Tables : ${config.includeTables.join(", ")}`);
    console.log(`  ENUMs  : ${Object.keys(enums).join(", ")}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("generate-schema failed:", err.message);
  process.exit(1);
});

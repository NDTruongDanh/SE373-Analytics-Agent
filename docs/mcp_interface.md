# MCP Interface (generated)

> Generated from `@se373/contracts` via `z.toJSONSchema()`. Do not hand-edit — run `pnpm docs:interface`.

## list_tables

Required scope: `schema:read`.

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "tables": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "schema": {
            "default": "public",
            "type": "string"
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "name",
          "schema"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "tables"
  ],
  "additionalProperties": false
}
```

## describe_table

Required scope: `schema:read`.

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "table": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  },
  "required": [
    "table"
  ],
  "additionalProperties": false
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "table": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "columns": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "type": "string",
            "minLength": 1
          },
          "nullable": {
            "type": "boolean"
          },
          "sensitive": {
            "type": "boolean"
          },
          "description": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "name",
          "type",
          "nullable",
          "sensitive"
        ],
        "additionalProperties": false
      }
    },
    "primaryKey": {
      "default": [],
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "foreignKeys": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "column": {
            "type": "string",
            "minLength": 1
          },
          "referencesTable": {
            "type": "string",
            "minLength": 1
          },
          "referencesColumn": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "column",
          "referencesTable",
          "referencesColumn"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "table",
    "columns",
    "primaryKey",
    "foreignKeys"
  ],
  "additionalProperties": false
}
```

## explain_query

Required scope: `schema:read`.

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sql": {
      "type": "string",
      "minLength": 1,
      "maxLength": 20000
    }
  },
  "required": [
    "sql"
  ],
  "additionalProperties": false
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "estimatedCost": {
      "type": "number",
      "minimum": 0
    },
    "estimatedRows": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "planJson": {}
  },
  "required": [
    "estimatedCost",
    "estimatedRows"
  ],
  "additionalProperties": false
}
```

## run_query

Required scope: `data:read`.

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sql": {
      "type": "string",
      "minLength": 1,
      "maxLength": 20000
    },
    "maxRows": {
      "default": 200,
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    }
  },
  "required": [
    "sql",
    "maxRows"
  ],
  "additionalProperties": false
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "columns": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "propertyNames": {
          "type": "string"
        },
        "additionalProperties": {}
      }
    },
    "rowCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "truncated": {
      "type": "boolean"
    },
    "maskedColumns": {
      "default": [],
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "durationMs": {
      "type": "number",
      "minimum": 0
    }
  },
  "required": [
    "columns",
    "rows",
    "rowCount",
    "truncated",
    "maskedColumns",
    "durationMs"
  ],
  "additionalProperties": false
}
```

## sample_rows

Required scope: `data:read`.

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "table": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "n": {
      "default": 5,
      "type": "integer",
      "minimum": 1,
      "maximum": 5
    }
  },
  "required": [
    "table",
    "n"
  ],
  "additionalProperties": false
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "columns": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "rows": {
      "type": "array",
      "items": {
        "type": "object",
        "propertyNames": {
          "type": "string"
        },
        "additionalProperties": {}
      }
    },
    "rowCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "columns",
    "rows",
    "rowCount"
  ],
  "additionalProperties": false
}
```

## Error codes

| Code | Name | Meaning |
|------|------|---------|
| E1 | UNAUTHORIZED | Missing or invalid token (HTTP 401) |
| E2 | SCOPE_DENIED | Caller lacks the scope the tool requires |
| E3 | INVALID_PARAMS | zod rejects the input shape |
| E4 | INVALID_SQL | SQL does not parse; cursor position returned |
| E5 | FORBIDDEN_STATEMENT | DDL/DML, multi-statement, SELECT INTO, FOR UPDATE, DML in CTE |
| E6 | FORBIDDEN_FUNCTION | Banned function call (pg_sleep, pg_read_file, dblink, set_config, …) |
| E7 | UNKNOWN_TABLE | Table/column missing, outside whitelist, or system schema |
| E8 | SENSITIVE_COLUMN_DENIED | Sensitive column outside projection without data:sensitive (fail-closed) |
| E9 | TIMEOUT | statement_timeout exceeded (PG 57014) |
| E10 | — (truncated flag) | Over maxRows: cut off, truncated = true (not an error) |
| E11 | INTERNAL_ERROR | DB or connection failure; details stay in the internal log |
| F17 | RATE_LIMITED (reserved) | Per-client rate limit exceeded |

## Worked example: run_query

Request (`run_query`, scope `data:read`):

```json
{
  "sql": "SELECT status, COUNT(*) AS n FROM orders GROUP BY status",
  "maxRows": 200
}
```

Response (`RunQueryOutput`):

```json
{
  "columns": [
    "status",
    "n"
  ],
  "rows": [
    {
      "status": "delivered",
      "n": 42
    },
    {
      "status": "shipped",
      "n": 7
    }
  ],
  "rowCount": 2,
  "truncated": false,
  "maskedColumns": [],
  "durationMs": 18
}
```

// PORT-01 factory unit tests (01-13). Fully DB-free per D-10: no DB URLs
// are read, and the only network use is a TCP dial to a closed loopback
// port (ECONNREFUSED proves fail-fast without any database).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, afterEach } from "vitest";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  CHECKPOINT_SCHEMA,
  createCheckpointer,
} from "../src/ports/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCheckpointer (DB-free)", () => {
  it("rejects an empty connection string before touching the network", async () => {
    await expect(createCheckpointer("")).rejects.toThrow(/non-empty/);
  });

  it("rejects the agent_ro connection string without connecting", async () => {
    const fromConn = vi.spyOn(PostgresSaver, "fromConnString");
    await expect(
      createCheckpointer(
        "postgresql://agent_ro:secret@127.0.0.1:5433/chosen",
      ),
    ).rejects.toThrow(/agent_ro/);
    // Never-rule 2: the read-only URL must not reach the driver.
    expect(fromConn).not.toHaveBeenCalled();
  });

  it("fails fast on an unreachable host (setup throws, no fallback)", async () => {
    // Closed loopback port: ECONNREFUSED, no database involved.
    await expect(
      createCheckpointer(
        "postgresql://harness_state:harness_state@127.0.0.1:54399/chosen",
      ),
    ).rejects.toThrow();
  }, 15000);

  it("passes schema langgraph to fromConnString and runs setup exactly once", async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const fromConn = vi
      .spyOn(PostgresSaver, "fromConnString")
      .mockImplementation((() => ({ setup }) as unknown) as typeof PostgresSaver.fromConnString);
    const conn = "postgresql://harness_state:harness_state@127.0.0.1:5433/chosen";
    const saver = await createCheckpointer(conn);
    expect(fromConn).toHaveBeenCalledTimes(1);
    expect(fromConn).toHaveBeenCalledWith(conn, { schema: "langgraph" });
    expect(CHECKPOINT_SCHEMA).toBe("langgraph");
    expect(setup).toHaveBeenCalledTimes(1);
    expect(saver).toBeDefined();
  });

  it("pins an explicit schema restatement to langgraph", async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const fromConn = vi
      .spyOn(PostgresSaver, "fromConnString")
      .mockImplementation((() => ({ setup }) as unknown) as typeof PostgresSaver.fromConnString);
    const conn = "postgresql://harness_state:harness_state@127.0.0.1:5433/chosen";
    await createCheckpointer(conn, { schema: "langgraph" });
    expect(fromConn).toHaveBeenCalledWith(conn, { schema: "langgraph" });
  });
});

describe("ports import bans (lint-adjacent)", () => {
  const sources = ["checkpoints.ts", "index.ts"].map((f) =>
    readFileSync(path.join(HERE, "..", "src", "ports", f), "utf8"),
  );

  it.each([0, 1])("ports source %i imports no pg/pg-cursor/MemorySaver", (i) => {
    const src = sources[i] as string;
    expect(src).not.toMatch(/from\s+["']pg["']/);
    expect(src).not.toMatch(/from\s+["']pg-cursor["']/);
    expect(src).not.toMatch(/require\(\s*["']pg["']\s*\)/);
    // Never-rule 1: the fallback must not even be imported (the word may
    // still appear in these doc comments).
    expect(src).not.toMatch(/import[^;]*MemorySaver/);
  });
});

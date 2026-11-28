import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_CSP_HEADER, securityHeadersMiddleware } from "../src/middleware/security.js";
import type { ClientRegistry } from "../src/principals.js";
import { createHealthRouter } from "../src/routes/health.js";
import { approvalDecision, extractInterruptInfo } from "../src/runtime/approvals.js";
import { rehydrateRun } from "../src/runtime/rehydrate.js";

describe("apps/api split modules", () => {
  describe("securityHeadersMiddleware and createHealthRouter", () => {
    let baseUrl = "";
    let server: ReturnType<express.Express["listen"]> | null = null;

    beforeAll(async () => {
      const app = express();
      app.use(securityHeadersMiddleware);
      app.use(createHealthRouter());
      server = app.listen(0);
      await new Promise<void>((resolve) => server?.on("listening", resolve));
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    });

    it("serves GET /healthz with CSP header", async () => {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(API_CSP_HEADER);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe("approvalDecision", () => {
    it("records allowlisted verdicts verbatim and redacts free-form user input", () => {
      expect(approvalDecision("Approve")).toEqual({ decision: "approve", valueLength: 7 });
      expect(approvalDecision("REJECT")).toEqual({ decision: "reject", valueLength: 6 });
      expect(approvalDecision("custom secret note")).toEqual({
        decision: "provided",
        valueLength: 18,
      });
      expect(approvalDecision({ choice: "north" })).toEqual({
        decision: "provided",
        valueLength: 18,
      });
    });

    it("extracts interrupt metadata and nested pendingClarification", () => {
      const interrupts = [
        {
          value: {
            action: "confirm_plan",
            reason: "needs review",
            asOf: "2026-01-01",
            plan: { steps: ["a"] },
            pendingClarification: {
              question: "Which region?",
              options: ["north", "south"],
            },
          },
        },
      ];
      const info = extractInterruptInfo(
        interrupts,
        { __interrupt__: interrupts, pendingClarification: null, analysisPlan: null } as never,
      );
      expect(info).toEqual({
        action: "confirm_plan",
        reason: "needs review",
        asOf: "2026-01-01",
        plan: { steps: ["a"] },
        currentPlan: undefined,
        pendingClarification: {
          question: "Which region?",
          options: ["north", "south"],
        },
      });
    });
  });

  describe("rehydrateRun", () => {
    let dir = "";
    const registry: ClientRegistry = {
      version: 1,
      clients: [
        {
          clientId: "sales_south",
          role: "sales_south",
          tokenEnv: "TEST_SALES_TOKEN",
          scopes: ["data:orders"],
        },
      ],
    };
    const env = { TEST_SALES_TOKEN: "tok-123" };

    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "api-rehydrate-"));
      writeFileSync(
        path.join(dir, "valid-run.jsonl"),
        `${JSON.stringify({
          runId: "valid-run",
          threadId: "chat:sales_south:1",
          userId: "sales_south",
          role: "sales_south",
        })}\n{"type":"other"}\n`,
      );
      writeFileSync(path.join(dir, "bad-json.jsonl"), "{not-json\n");
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("rehydrates a valid header and fails closed on path traversal or malformed headers", () => {
      expect(rehydrateRun("valid-run", registry, env, "http://127.0.0.1:8081/mcp", dir)).toEqual({
        threadId: "chat:sales_south:1",
        userId: "sales_south",
        roleScope: "sales_south",
        token: "tok-123",
        mcpUrl: "http://127.0.0.1:8081/mcp",
        tracesDir: dir,
      });
      expect(rehydrateRun("../valid-run", registry, env, "http://127.0.0.1:8081/mcp", dir)).toBeNull();
      expect(rehydrateRun("bad-json", registry, env, "http://127.0.0.1:8081/mcp", dir)).toBeNull();
      expect(rehydrateRun("missing-run", registry, env, "http://127.0.0.1:8081/mcp", dir)).toBeNull();
    });
  });
});

import { Router, type Request, type Response } from "express";
import { dbToolError } from "@shared/contracts";
import { resolveRequestPersona } from "../middleware/persona.js";
import type { AppContext, ReindexResult } from "../types.js";

export async function defaultReindex(ctx: {
  token: string;
  mcpUrl: string;
}): Promise<ReindexResult> {
  const url = new URL("/reindex", ctx.mcpUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.token}`,
    },
  });
  if (!res.ok) {
    let message = `semantic re-index failed with status ${res.status}`;
    try {
      const text = await res.text();
      if (text) message = text;
    } catch {
    }
    throw new Error(message);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    added: Number(body["added"] ?? 0),
    updated: Number(body["updated"] ?? 0),
    skipped: Number(body["skipped"] ?? 0),
    deleted: Number(body["deleted"] ?? 0),
  };
}

export function createSemanticRouter(ctx: AppContext): Router {
  const router = Router();

  router.post("/semantic/reindex", async (req: Request, res: Response) => {
    const resolved = resolveRequestPersona(req, res, ctx.registry, ctx.env, {
      allowHeader: true,
    });
    if (!resolved) return;
    const { persona, principal, token } = resolved;

    if (persona !== "data_admin" || principal.role !== "admin") {
      res
        .status(403)
        .json(dbToolError("SCOPE_DENIED", "only data_admin may trigger semantic re-indexing"));
      return;
    }
    try {
      const reindex = ctx.options.reindex ?? defaultReindex;
      const counts = await reindex({ token, mcpUrl: ctx.options.mcpUrl });
      res.status(200).json(counts);
    } catch (error) {
      res
        .status(500)
        .json(
          dbToolError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "semantic re-index failed",
          ),
        );
    }
  });

  return router;
}

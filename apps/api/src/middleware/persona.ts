import type { Request, Response } from "express";
import { dbToolError } from "@shared/contracts";
import {
  resolvePersona,
  UnknownPersonaError,
  type ClientRegistry,
  type Principal,
} from "../principals.js";

export interface ResolvedPersona {
  persona: string;
  principal: Principal;
  token: string;
}

export function resolveRequestPersona(
  req: Request,
  res: Response,
  registry: ClientRegistry,
  env: NodeJS.ProcessEnv,
  opts?: { allowHeader?: boolean },
): ResolvedPersona | null {
  const rawPersona = opts?.allowHeader
    ? (req.body?.["persona"] ?? req.headers["x-persona"])
    : req.body?.["persona"];
  try {
    if (typeof rawPersona !== "string") {
      throw new UnknownPersonaError(String(rawPersona));
    }
    const { principal, token } = resolvePersona(rawPersona, registry, env);
    return { persona: rawPersona, principal, token };
  } catch (error) {
    if (error instanceof UnknownPersonaError) {
      res.status(error.status).json(dbToolError("INVALID_PARAMS", error.message));
      return null;
    }
    res
      .status(500)
      .json(dbToolError("INTERNAL_ERROR", "persona resolution failed at boot-checked config"));
    return null;
  }
}

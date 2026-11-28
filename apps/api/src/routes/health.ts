import { Router, type Request, type Response } from "express";

export function createHealthRouter(): Router {
  const router = Router();
  router.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  return router;
}

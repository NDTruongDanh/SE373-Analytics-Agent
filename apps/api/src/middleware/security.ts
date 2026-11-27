import type { NextFunction, Request, Response } from "express";

export const API_CSP_HEADER =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'";

export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-security-policy": API_CSP_HEADER,
};

export function securityHeadersMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("content-security-policy", API_CSP_HEADER);
  next();
}

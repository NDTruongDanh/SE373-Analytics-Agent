import { createHash } from "node:crypto";

export interface AlertFingerprintInput {
  recipientId: string;
  metric: string;
  dimensionKey: string;
  date: string;
  direction: string;
}

/**
 * Canonical alert fingerprint calculation:
 * SHA-256 hex digest over recipientId|metric|dimensionKey|date|direction.
 * Matches UC-10 §7 and apps/api AppStateStore exactly so identical
 * fingerprints are produced across agent and host.
 */
export function calculateAlertFingerprint(input: AlertFingerprintInput): string {
  return createHash("sha256")
    .update(
      [
        input.recipientId,
        input.metric,
        input.dimensionKey,
        input.date,
        input.direction,
      ].join("|"),
      "utf8",
    )
    .digest("hex");
}


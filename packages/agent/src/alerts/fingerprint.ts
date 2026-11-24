import { createHash } from "node:crypto";

export interface AlertFingerprintInput {
  recipientId: string;
  metric: string;
  dimensionKey: string;
  date: string;
  direction: string;
}

/** Must stay identical to apps/api AppStateStore so agent and host deduplicate on the same fingerprint. */
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


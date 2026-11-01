import { SSE_EVENT_NAMES, type SseEventName } from "@shared/contracts";

/** Allowlist exactly matching the contracts per-event schemas (D-20). */
export const SSE_ALLOWLIST: readonly SseEventName[] = SSE_EVENT_NAMES;

/** Static UI-persona → registry-client table (architecture section 3.2).
 * sales_south is the demo/compat alias for the Regional Manager South seat.
 */
export const PERSONA_TO_CLIENT: Record<string, string> = {
  sales_south: "sales_south",
  regional_manager_south: "sales_south",
  marketing: "marketing",
  hr: "hr",
  data_admin: "admin",
};

/** Upper bound for thread ids (matches the 01-12 HITL limit). */
export const THREAD_ID_MAX_LENGTH = 255;

export const API_SHELL =
  "API host: Express SSE streaming with persona principals, injected persistence ports, and resume";

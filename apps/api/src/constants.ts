import { SSE_EVENT_NAMES, type SseEventName } from "@shared/contracts";

export const SSE_ALLOWLIST: readonly SseEventName[] = SSE_EVENT_NAMES;

// sales_south is retained as a demo/compat alias for the Regional Manager South seat.
export const PERSONA_TO_CLIENT: Record<string, string> = {
  sales_south: "sales_south",
  regional_manager_south: "sales_south",
  marketing: "marketing",
  hr: "hr",
  data_admin: "admin",
};

export const THREAD_ID_MAX_LENGTH = 255;

export const API_SHELL =
  "API host: Express SSE streaming with persona principals, injected persistence ports, and resume";

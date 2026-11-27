import { afterEach, describe, expect, it } from "vitest";
import {
  createProviderFetch,
  resetProviderResilienceState,
  type SemanticCacheContext,
} from "../src/models/providerResilience.js";

const PRIMARY_URL = "https://primary.example/v1";
const SECONDARY_URL = "https://secondary.example/v1";
const REQUEST_URL = `${PRIMARY_URL}/chat/completions`;
const REQUEST_BODY = JSON.stringify({ model: "primary-model", messages: [{ role: "user", content: "Revenue?" }] });

function request(): Request {
  return new Request(REQUEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer primary-key" },
    body: REQUEST_BODY,
  });
}

afterEach(() => resetProviderResilienceState());

describe("provider resilience", () => {
  it("opens after three primary 5xx responses and probes it again after 30 seconds", async () => {
    let now = 1000;
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const received = new Request(input);
      if (received.url.startsWith(PRIMARY_URL)) {
        primaryCalls += 1;
        return primaryCalls <= 3
          ? new Response("overloaded", { status: 500 })
          : Response.json({ provider: "primary" });
      }
      secondaryCalls += 1;
      expect(received.url).toBe(`${SECONDARY_URL}/chat/completions`);
      expect(received.headers.get("authorization")).toBe("Bearer secondary-key");
      expect((await received.json()).model).toBe("secondary-model");
      return Response.json({ provider: "secondary" });
    }) as typeof fetch;
    const providerFetch = createProviderFetch({
      primaryBaseURL: PRIMARY_URL,
      secondary: { baseURL: SECONDARY_URL, apiKey: "secondary-key", model: "secondary-model" },
      env: { AGENT_MODEL_SEMANTIC_CACHE_TTL_MS: "0" },
      fetchImpl,
      now: () => now,
    });

    for (let i = 0; i < 4; i += 1) {
      expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    }
    expect(primaryCalls).toBe(3);
    expect(secondaryCalls).toBe(4);

    now += 30_000;
    expect(await (await providerFetch(request())).json()).toEqual({ provider: "primary" });
    expect(primaryCalls).toBe(4);
    expect(secondaryCalls).toBe(4);
    expect(await (await providerFetch(request())).json()).toEqual({ provider: "primary" });
    expect(primaryCalls).toBe(5);
  });

  it("separates cached responses by role and row scope", async () => {
    let calls = 0;
    const fetchImpl = (async () => Response.json({ call: ++calls })) as typeof fetch;
    const context = (role: string, value: string): SemanticCacheContext => ({
      analysisState: { question: "Revenue?" },
      semanticChunks: [{ chunkId: "metric:revenue" }],
      role,
      rowScope: { column: "region", value },
    });
    const options = {
      primaryBaseURL: PRIMARY_URL,
      env: { AGENT_MODEL_SEMANTIC_CACHE_TTL_MS: "60000" },
      fetchImpl,
      now: () => 1000,
    };
    const south = createProviderFetch({ ...options, cacheContext: context("sales", "south") });
    const north = createProviderFetch({ ...options, cacheContext: context("sales", "north") });
    const admin = createProviderFetch({ ...options, cacheContext: context("admin", "south") });

    expect(await (await south(request())).json()).toEqual({ call: 1 });
    expect(await (await south(request())).json()).toEqual({ call: 1 });
    expect(await (await north(request())).json()).toEqual({ call: 2 });
    expect(await (await admin(request())).json()).toEqual({ call: 3 });
    expect(calls).toBe(3);
  });

  it("opens after three primary transport errors and resets cooldown on half-open failure", async () => {
    let now = 1_000;
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const received = new Request(input);
      if (received.url.startsWith(PRIMARY_URL)) {
        primaryCalls += 1;
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      }
      secondaryCalls += 1;
      return Response.json({ provider: "secondary" });
    }) as typeof fetch;

    const providerFetch = createProviderFetch({
      primaryBaseURL: PRIMARY_URL,
      secondary: { baseURL: SECONDARY_URL, apiKey: "secondary-key", model: "secondary-model" },
      env: { AGENT_MODEL_SEMANTIC_CACHE_TTL_MS: "0" },
      fetchImpl,
      now: () => now,
    });

    for (let i = 0; i < 4; i += 1) {
      expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    }
    expect(primaryCalls).toBe(3);
    expect(secondaryCalls).toBe(4);

    now += 30_000;
    expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    expect(primaryCalls).toBe(4);
    expect(secondaryCalls).toBe(5);

    now += 15_000;
    expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    expect(primaryCalls).toBe(4);
    expect(secondaryCalls).toBe(6);
  });

  it("does not fail over or trip breaker when caller aborts with AbortController", async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const received = new Request(input);
      if (received.url.startsWith(PRIMARY_URL)) {
        primaryCalls += 1;
        throw new DOMException("This operation was aborted", "AbortError");
      }
      secondaryCalls += 1;
      return Response.json({ provider: "secondary" });
    }) as typeof fetch;

    const providerFetch = createProviderFetch({
      primaryBaseURL: PRIMARY_URL,
      secondary: { baseURL: SECONDARY_URL, apiKey: "secondary-key", model: "secondary-model" },
      env: { AGENT_MODEL_SEMANTIC_CACHE_TTL_MS: "0" },
      fetchImpl,
    });

    for (let i = 0; i < 4; i += 1) {
      const controller = new AbortController();
      const req = new Request(REQUEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer primary-key" },
        body: REQUEST_BODY,
        signal: controller.signal,
      });
      controller.abort();
      await expect(providerFetch(req)).rejects.toThrow();
    }
    expect(primaryCalls).toBe(4);
    expect(secondaryCalls).toBe(0);
  });

  it("does not count HTTP 429 or 401 on primary as a circuit-resetting success", async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const received = new Request(input);
      if (received.url.startsWith(PRIMARY_URL)) {
        primaryCalls += 1;
        if (primaryCalls === 3) return new Response("rate limited", { status: 429 });
        return new Response("overloaded", { status: 500 });
      }
      secondaryCalls += 1;
      return Response.json({ provider: "secondary" });
    }) as typeof fetch;

    const providerFetch = createProviderFetch({
      primaryBaseURL: PRIMARY_URL,
      secondary: { baseURL: SECONDARY_URL, apiKey: "secondary-key", model: "secondary-model" },
      env: { AGENT_MODEL_SEMANTIC_CACHE_TTL_MS: "0" },
      fetchImpl,
      now: () => 1_000,
    });

    expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    const rateLimited = await providerFetch(request());
    expect(rateLimited.status).toBe(429);
    expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    expect(await (await providerFetch(request())).json()).toEqual({ provider: "secondary" });
    expect(primaryCalls).toBe(4);
    expect(secondaryCalls).toBe(4);
  });
});

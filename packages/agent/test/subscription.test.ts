import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBSCRIPTIONS_PATH,
  loadSubscriptionsConfig,
  loadSubscriptionsConfigFile,
} from "../src/alerts/subscription.js";

describe("loadSubscriptionsConfig and loadSubscriptionsConfigFile", () => {
  it("resolves default subscriptions config file successfully", () => {
    const config = loadSubscriptionsConfigFile();
    expect(config.version).toBe(1);
    expect(config.subscriptions.length).toBeGreaterThanOrEqual(1);
  });

  it("supports explicit filePath argument override", () => {
    const config = loadSubscriptionsConfigFile(DEFAULT_SUBSCRIPTIONS_PATH);
    expect(config.version).toBe(1);
    expect(config.subscriptions[0].id).toBeDefined();
  });

  it("supports envOverride injection via SUBSCRIPTIONS_PATH", () => {
    const config = loadSubscriptionsConfigFile(undefined, DEFAULT_SUBSCRIPTIONS_PATH);
    expect(config.version).toBe(1);
  });

  it("throws on malformed YAML text", () => {
    expect(() => loadSubscriptionsConfig("invalid: yaml: [")).toThrow(
      /Invalid subscriptions YAML syntax/,
    );
  });
});

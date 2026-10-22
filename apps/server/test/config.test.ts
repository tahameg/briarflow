import { DEFAULT_CORS_ORIGINS } from "@briarflow/server";
import { describe, expect, it } from "vitest";
import { ConfigError, isLoopback, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("has working defaults", () => {
    expect(loadConfig({}, { defaultStudioDir: "/studio" })).toEqual({
      port: 3000,
      host: "127.0.0.1",
      dataDir: "./data",
      corsOrigins: DEFAULT_CORS_ORIGINS,
      studioDir: "/studio",
      python: undefined,
      mock: true,
      providerKeys: { anthropic: false },
      studioStart: {},
    });
  });

  it("reads the studio start context and flow", () => {
    expect(loadConfig({ BRIAR_STUDIO_CONTEXT: "Marketing", BRIAR_STUDIO_FLOW: "Portrait" }).studioStart).toEqual({ context: "Marketing", flow: "Portrait" });
    expect(() => loadConfig({ BRIAR_STUDIO_FLOW: "Portrait" })).toThrow(/BRIAR_STUDIO_CONTEXT/);
  });

  it("reads every variable", () => {
    const config = loadConfig({
      PORT: "8080",
      HOST: "0.0.0.0",
      BRIAR_DATA_DIR: "/data",
      BRIAR_CORS_ORIGIN: "https://a.example, https://b.example",
      BRIAR_STUDIO_DIR: "off",
      BRIAR_PYTHON_WORKER_URL: "http://worker:8765",
      BRIAR_PYTHON_WORKER_TOKEN: "t",
      BRIAR_MOCK_NODES: "false",
      ANTHROPIC_API_KEY: "sk-ant-x",
    });
    expect(config).toMatchObject({
      port: 8080,
      host: "0.0.0.0",
      dataDir: "/data",
      corsOrigins: ["https://a.example", "https://b.example"],
      studioDir: undefined,
      python: { url: "http://worker:8765", token: "t" },
      mock: false,
      providerKeys: { anthropic: true },
    });
    expect(loadConfig({ BRIAR_CORS_ORIGIN: "off" }).corsOrigins).toBe(false);
  });

  it("names the bad variable and the fix", () => {
    expect(() => loadConfig({ PORT: "http" })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: "http" })).toThrow('Environment variable PORT="http" is invalid: use a port number between 0 and 65535.');
    expect(() => loadConfig({ BRIAR_MOCK_NODES: "maybe" })).toThrow(/BRIAR_MOCK_NODES.*true or false/);
  });

  it("detects loopback hosts", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
  });
});

describe("loadProviderPacks", () => {
  it("adds the anthropic pack only when ANTHROPIC_API_KEY is set", async () => {
    const { loadProviderPacks } = await import("../src/providers.js");
    expect(loadProviderPacks(loadConfig({})).map((p) => p.name)).toEqual([]);
    expect(loadProviderPacks(loadConfig({ ANTHROPIC_API_KEY: "sk-ant-x" })).map((p) => p.name)).toEqual(["anthropic"]);
  });
});

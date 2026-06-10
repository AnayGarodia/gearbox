// Tests for the models.dev catalog sync (src/model/modelsdev.ts).
// The fixture below is REAL data trimmed from https://models.dev/api.json
// (fetched 2026-06-10): 3 providers × 5 models, chosen to exercise every
// mapping branch — cache_read pricing, a provider-id remap (amazon-bedrock →
// bedrock), a text-only model (images=false), and a free model with no cost.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchModelsDev,
  loadCachedCatalog,
  mapProviderId,
  mergeIntoRegistry,
  parseModelsDev,
  saveCachedCatalog,
  syncModelsDev,
  type ModelsDevEntry,
} from "../src/model/modelsdev.ts";

// ── fixture: trimmed verbatim from the live api.json ─────────────────────────
const FIXTURE = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    npm: "@ai-sdk/anthropic",
    doc: "https://docs.anthropic.com/en/docs/about-claude/models",
    models: {
      "claude-opus-4-5": {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5 (latest)",
        family: "claude-opus",
        attachment: true,
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
        tool_call: true,
        temperature: true,
        knowledge: "2025-03-31",
        release_date: "2025-11-24",
        last_updated: "2025-11-24",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        open_weights: false,
        limit: { context: 200000, output: 64000 },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5 (latest)",
        family: "claude-haiku",
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        tool_call: true,
        temperature: true,
        knowledge: "2025-02-28",
        release_date: "2025-10-15",
        last_updated: "2025-10-15",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        open_weights: false,
        limit: { context: 200000, output: 64000 },
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    env: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    npm: "@ai-sdk/google",
    models: {
      "gemini-2.5-flash-lite": {
        id: "gemini-2.5-flash-lite",
        name: "Gemini 2.5 Flash-Lite",
        attachment: true,
        reasoning: true,
        tool_call: true,
        temperature: true,
        modalities: { input: ["text", "image", "audio", "video", "pdf"], output: ["text"] },
        limit: { context: 1048576, output: 65536 },
        cost: { input: 0.1, output: 0.4, cache_read: 0.01, input_audio: 0.3 },
      },
      // Free/open-weights listing: NO cost block at all.
      "gemma-4-31b-it": {
        id: "gemma-4-31b-it",
        name: "Gemma 4 31B IT",
        family: "gemma",
        attachment: true,
        reasoning: true,
        tool_call: true,
        structured_output: true,
        temperature: true,
        release_date: "2026-04-02",
        last_updated: "2026-04-02",
        modalities: { input: ["text", "image"], output: ["text"] },
        open_weights: true,
        limit: { context: 262144, output: 32768 },
      },
    },
  },
  // models.dev id "amazon-bedrock" must remap to gearbox "bedrock".
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"],
    models: {
      "amazon.nova-micro-v1:0": {
        id: "amazon.nova-micro-v1:0",
        name: "Nova Micro",
        family: "nova-micro",
        attachment: false,
        reasoning: false,
        tool_call: true,
        temperature: true,
        knowledge: "2024-10",
        release_date: "2024-12-03",
        last_updated: "2024-12-03",
        modalities: { input: ["text"], output: ["text"] },
        open_weights: false,
        limit: { context: 128000, output: 8192 },
        cost: { input: 0.035, output: 0.14, cache_read: 0.00875 },
      },
    },
  },
} as const;

const byId = (entries: ModelsDevEntry[], id: string) => entries.find((e) => e.id === id);

// ── parse ─────────────────────────────────────────────────────────────────────

describe("parseModelsDev", () => {
  test("parses the fixture into normalized entries", () => {
    const entries = parseModelsDev(FIXTURE);
    expect(entries.length).toBe(5);

    const opus = byId(entries, "claude-opus-4-5");
    expect(opus).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-5",
      label: "Claude Opus 4.5 (latest)",
      contextWindow: 200000,
      maxOutput: 64000,
      cost: { inUSDPerMtok: 5, outUSDPerMtok: 25, cacheReadUSDPerMtok: 0.5 },
      tools: true,
      images: true,
      reasoning: true,
    });

    const haiku = byId(entries, "claude-haiku-4-5");
    expect(haiku?.cost).toEqual({ inUSDPerMtok: 1, outUSDPerMtok: 5, cacheReadUSDPerMtok: 0.1 });
  });

  test("maps amazon-bedrock to the gearbox provider id and reads capability flags", () => {
    const entries = parseModelsDev(FIXTURE);
    const nova = byId(entries, "amazon.nova-micro-v1:0");
    expect(nova?.provider).toBe("bedrock");
    expect(nova?.label).toBe("Nova Micro");
    expect(nova?.tools).toBe(true);
    expect(nova?.reasoning).toBe(false);
    expect(nova?.images).toBe(false); // modalities.input = ["text"] only
    expect(nova?.contextWindow).toBe(128000);
    expect(nova?.maxOutput).toBe(8192);
    expect(nova?.cost).toEqual({ inUSDPerMtok: 0.035, outUSDPerMtok: 0.14, cacheReadUSDPerMtok: 0.00875 });
  });

  test("multimodal flags come from modalities.input", () => {
    const entries = parseModelsDev(FIXTURE);
    const flash = byId(entries, "gemini-2.5-flash-lite");
    expect(flash?.provider).toBe("google");
    expect(flash?.images).toBe(true);
    expect(flash?.contextWindow).toBe(1048576);
    expect(flash?.cost).toEqual({ inUSDPerMtok: 0.1, outUSDPerMtok: 0.4, cacheReadUSDPerMtok: 0.01 });
  });

  test("a model with no cost block keeps cost undefined (not $0)", () => {
    const entries = parseModelsDev(FIXTURE);
    const gemma = byId(entries, "gemma-4-31b-it");
    expect(gemma).toBeDefined();
    expect(gemma?.cost).toBeUndefined();
    expect(gemma?.contextWindow).toBe(262144);
    expect(gemma?.maxOutput).toBe(32768);
    expect(gemma?.reasoning).toBe(true);
  });

  test("tolerates malformed input without throwing", () => {
    expect(parseModelsDev(null)).toEqual([]);
    expect(parseModelsDev(undefined)).toEqual([]);
    expect(parseModelsDev(42)).toEqual([]);
    expect(parseModelsDev([1, 2, 3])).toEqual([]);
    expect(parseModelsDev({ p: "not an object" })).toEqual([]);
    expect(parseModelsDev({ p: { models: "nope" } })).toEqual([]);
    // a junk model among good ones is skipped, not fatal; junk fields omitted
    const messy = {
      p: {
        id: "p",
        models: {
          bad: 7,
          ok: { name: "OK", limit: { context: "huge" }, cost: { input: "free", output: 1 } },
        },
      },
    };
    const entries = parseModelsDev(messy);
    expect(entries).toEqual([{ provider: "p", id: "ok", label: "OK" }]);
  });

  test("falls back to the map key / id when name or model.id is missing", () => {
    const entries = parseModelsDev({ p: { models: { "model-x": {} } } });
    expect(entries).toEqual([{ provider: "p", id: "model-x", label: "model-x" }]);
  });
});

// ── provider-id mapping ───────────────────────────────────────────────────────

describe("mapProviderId", () => {
  test("remaps models.dev ids that differ from gearbox catalog ids", () => {
    expect(mapProviderId("amazon-bedrock")).toBe("bedrock");
    expect(mapProviderId("google-vertex")).toBe("vertex");
    expect(mapProviderId("google-vertex-anthropic")).toBe("vertex");
    expect(mapProviderId("togetherai")).toBe("together");
    expect(mapProviderId("fireworks-ai")).toBe("fireworks");
    expect(mapProviderId("moonshotai")).toBe("moonshot");
    expect(mapProviderId("novita-ai")).toBe("novita");
    expect(mapProviderId("vercel")).toBe("vercel-gateway");
  });

  test("passes identical and unknown ids through unchanged", () => {
    for (const same of ["anthropic", "openai", "google", "deepseek", "xai", "groq", "openrouter", "azure"]) {
      expect(mapProviderId(same)).toBe(same);
    }
    expect(mapProviderId("zhipuai")).toBe("zhipuai"); // deliberately unmapped
    expect(mapProviderId("some-future-provider")).toBe("some-future-provider");
  });
});

// ── merge ─────────────────────────────────────────────────────────────────────

describe("mergeIntoRegistry", () => {
  const entries = parseModelsDev(FIXTURE);

  test("drops entries already in the curated registry (curated wins)", () => {
    const existing = [
      { provider: "anthropic", sdkId: "claude-opus-4-5" },
      { provider: "bedrock", sdkId: "amazon.nova-micro-v1:0" },
    ];
    const merged = mergeIntoRegistry(entries, existing);
    expect(merged.length).toBe(3);
    expect(byId(merged, "claude-opus-4-5")).toBeUndefined();
    expect(byId(merged, "amazon.nova-micro-v1:0")).toBeUndefined();
    expect(byId(merged, "claude-haiku-4-5")).toBeDefined();
  });

  test("dedupe is per (provider, id) pair, not id alone", () => {
    // same sdkId under a DIFFERENT provider must survive
    const merged = mergeIntoRegistry(entries, [{ provider: "openrouter", sdkId: "claude-opus-4-5" }]);
    expect(byId(merged, "claude-opus-4-5")?.provider).toBe("anthropic");
  });

  test("collapses duplicate pairs within the incoming entries (first wins)", () => {
    const dupe: ModelsDevEntry[] = [
      { provider: "p", id: "m", label: "first" },
      { provider: "p", id: "m", label: "second" },
    ];
    const merged = mergeIntoRegistry(dupe, []);
    expect(merged.length).toBe(1);
    expect(merged[0]?.label).toBe("first");
  });

  test("empty registry keeps everything", () => {
    expect(mergeIntoRegistry(entries, []).length).toBe(5);
  });
});

// ── disk cache + sync (under a temp GEARBOX_HOME) ─────────────────────────────

describe("cache + sync", () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gearbox-modelsdev-"));
    prevHome = process.env.GEARBOX_HOME;
    process.env.GEARBOX_HOME = dir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.GEARBOX_HOME;
    else process.env.GEARBOX_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  // typed fetch stubs
  const fetchOk =
    (body: unknown, calls?: { n: number }): typeof fetch =>
    (async () => {
      if (calls) calls.n++;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  const fetchFail = (calls?: { n: number }): typeof fetch =>
    (async () => {
      if (calls) calls.n++;
      throw new Error("network down");
    }) as unknown as typeof fetch;

  test("save/load round-trips through ${GEARBOX_HOME}/models-dev.json", () => {
    const entries = parseModelsDev(FIXTURE);
    saveCachedCatalog(entries);
    expect(existsSync(join(dir, "models-dev.json"))).toBe(true);
    // atomic write: the temp file must not be left behind after the rename
    expect(existsSync(join(dir, "models-dev.json.tmp"))).toBe(false);
    const cached = loadCachedCatalog();
    expect(cached).not.toBeNull();
    expect(cached!.entries).toEqual(entries);
    expect(typeof cached!.fetchedAt).toBe("number");
    expect(Date.now() - cached!.fetchedAt).toBeLessThan(60_000);
  });

  test("loadCachedCatalog returns null when absent or corrupt", () => {
    expect(loadCachedCatalog()).toBeNull();
    writeFileSync(join(dir, "models-dev.json"), "{not json");
    expect(loadCachedCatalog()).toBeNull();
    writeFileSync(join(dir, "models-dev.json"), JSON.stringify({ wrong: "shape" }));
    expect(loadCachedCatalog()).toBeNull();
  });

  test("fetchModelsDev returns the catalog on success", async () => {
    const got = await fetchModelsDev(fetchOk(FIXTURE));
    expect(got).not.toBeNull();
    expect(got!.anthropic?.models?.["claude-opus-4-5"]?.name).toBe("Claude Opus 4.5 (latest)");
  });

  test("fetchModelsDev returns null on any failure (never throws)", async () => {
    expect(await fetchModelsDev(fetchFail())).toBeNull();
    expect(await fetchModelsDev((async () => new Response("nope", { status: 500 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchModelsDev((async () => new Response("{not json", { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchModelsDev((async () => new Response("[1,2]", { status: 200 })) as unknown as typeof fetch)).toBeNull();
  });

  test("syncModelsDev: fresh cache is returned without fetching", async () => {
    const entries = parseModelsDev(FIXTURE);
    saveCachedCatalog(entries);
    const calls = { n: 0 };
    const got = await syncModelsDev({ fetchImpl: fetchFail(calls) });
    expect(got).toEqual(entries);
    expect(calls.n).toBe(0);
  });

  test("syncModelsDev: stale cache triggers fetch and refreshes the file", async () => {
    const stale: ModelsDevEntry[] = [{ provider: "anthropic", id: "old-model", label: "old" }];
    writeFileSync(join(dir, "models-dev.json"), JSON.stringify({ fetchedAt: Date.now() - 48 * 3600_000, entries: stale }));
    const calls = { n: 0 };
    const got = await syncModelsDev({ fetchImpl: fetchOk(FIXTURE, calls) });
    expect(calls.n).toBe(1);
    expect(got.length).toBe(5);
    // the cache file was rewritten with the fresh entries
    const onDisk = JSON.parse(readFileSync(join(dir, "models-dev.json"), "utf8"));
    expect(onDisk.entries.length).toBe(5);
  });

  test("syncModelsDev: offline falls back to the stale cache", async () => {
    const stale: ModelsDevEntry[] = [{ provider: "anthropic", id: "old-model", label: "old" }];
    writeFileSync(join(dir, "models-dev.json"), JSON.stringify({ fetchedAt: Date.now() - 48 * 3600_000, entries: stale }));
    const got = await syncModelsDev({ fetchImpl: fetchFail() });
    expect(got).toEqual(stale);
  });

  test("syncModelsDev: no cache and offline yields []", async () => {
    const got = await syncModelsDev({ fetchImpl: fetchFail() });
    expect(got).toEqual([]);
  });

  test("syncModelsDev honors a custom maxAgeMs", async () => {
    saveCachedCatalog([{ provider: "anthropic", id: "cached-model", label: "cached" }]);
    const calls = { n: 0 };
    // maxAgeMs 0 → even a just-written cache counts as stale → fetch runs
    const got = await syncModelsDev({ maxAgeMs: 0, fetchImpl: fetchOk(FIXTURE, calls) });
    expect(calls.n).toBe(1);
    expect(got.length).toBe(5);
  });
});

import { describe, expect, test } from "bun:test";
import { loadEngineProfile } from "../../../src/core/engine/profile";
import { resolveBuiltInTools } from "../../../src/core/agent-loop/tool-surface";
import {
  clearSessionWebSearchOverride,
  effectiveWebSearchEnabled,
  setSessionWebSearchOverride,
} from "../../../src/core/agent-loop/web-search-state";

const capable = { capabilities: { builtinWebSearch: true }, webSearchDefault: false };
const capableDefaultOn = { capabilities: { builtinWebSearch: true }, webSearchDefault: true };
const incapableDefaultOn = { capabilities: {}, webSearchDefault: true };

describe("web search toggle state", () => {
  test("default is off and the model default applies only with the capability", () => {
    expect(effectiveWebSearchEnabled(capable, "s1")).toBe(false);
    expect(effectiveWebSearchEnabled(capableDefaultOn, "s1")).toBe(true);
    // A preference alone never turns an unsupported model on.
    expect(effectiveWebSearchEnabled(incapableDefaultOn, "s1")).toBe(false);
  });

  test("session override wins over the model default and clears per session", () => {
    setSessionWebSearchOverride("s1", true);
    expect(effectiveWebSearchEnabled(capable, "s1")).toBe(true);
    // Other sessions are untouched.
    expect(effectiveWebSearchEnabled(capable, "s2")).toBe(false);

    setSessionWebSearchOverride("s2", false);
    expect(effectiveWebSearchEnabled(capableDefaultOn, "s2")).toBe(false);

    clearSessionWebSearchOverride("s2");
    expect(effectiveWebSearchEnabled(capableDefaultOn, "s2")).toBe(true);

    // An override cannot push an incapable model on either.
    setSessionWebSearchOverride("s3", true);
    expect(effectiveWebSearchEnabled(incapableDefaultOn, "s3")).toBe(false);
  });
});

describe("web search tool surface policy", () => {
  test("built-in search on removes only the host web_search tool", async () => {
    const profile = await loadEngineProfile("etl");
    const off = resolveBuiltInTools(profile, false);
    const on = resolveBuiltInTools(profile, false, false, "auto", undefined, { builtinSearchEnabled: true });
    expect(off.some((tool) => tool.function.name === "web_search")).toBe(true);
    expect(on.some((tool) => tool.function.name === "web_search")).toBe(false);
    // The other Tavily URL tools stay available alongside built-in search.
    expect(on.some((tool) => tool.function.name === "web_fetch")).toBe(true);
  });

  test("built-in search on and a missing Tavily key compose without leaking web_search", async () => {
    const profile = await loadEngineProfile("etl");
    const surface = resolveBuiltInTools(profile, false, false, "auto", undefined, {
      builtinSearchEnabled: true,
      tavilyConfigured: false,
    });
    const names = surface.map((tool) => tool.function.name);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
    // Unrelated host tools keep their normal visibility.
    expect(surface.length).toBeGreaterThan(0);
  });

  test("a missing Tavily key hides the whole Tavily tool family", async () => {
    const profile = await loadEngineProfile("etl");
    const surface = resolveBuiltInTools(profile, false, false, "auto", undefined, { tavilyConfigured: false });
    const names = surface.map((tool) => tool.function.name);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("web_map");
    expect(names).not.toContain("web_crawl");
    expect(names).not.toContain("web_research");
  });
});

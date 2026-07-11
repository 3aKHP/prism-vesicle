import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { executeWebCrawlTool, executeWebFetchTool, executeWebMapTool, executeWebResearchTool, executeWebSearchTool } from "../src/core/tools";

describe("web_search tool", () => {
  test("calls Tavily with a bounded lightweight request and returns structured results", async () => {
    const configDir = await makeConfigDir("web-search-ok");
    await writeFile(join(configDir, ".env"), "TAVILY_API_KEY=test-tavily-key\n", "utf8");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await executeWebSearchTool(
      {
        id: "call-1",
        name: "web_search",
        arguments: JSON.stringify({
          query: "Prism Engine state space",
          maxResults: 50,
          searchDepth: "advanced",
          timeRange: "month",
          startDate: "2026-01-01",
          endDate: "2026-02-01",
          allowedDomains: ["https://example.com/docs/path", " tavily.com "],
          blockedDomains: ["spam.example/path"],
        }),
      },
      {
        env: { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") },
        fetchImpl: (async (url, init) => {
          requests.push({ url: String(url), init: init ?? {} });
          return Response.json({
            results: [
              {
                title: "State Space",
                url: "https://example.com/a",
                content: "A concise result snippet.",
                score: 0.92,
                published_date: "2026-01-02",
              },
            ],
          });
        }) as typeof fetch,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.webEvent).toEqual({
      kind: "web_search",
      provider: "tavily",
      query: "Prism Engine state space",
      resultCount: 1,
      urls: ["https://example.com/a"],
    });
    expect(JSON.parse(result.content)).toMatchObject({
      query: "Prism Engine state space",
      results: [
        {
          title: "State Space",
          url: "https://example.com/a",
          snippet: "A concise result snippet.",
          score: 0.92,
          publishedAt: "2026-01-02",
        },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.tavily.com/search");
    expect(requests[0].init.headers).toEqual({
      "Authorization": "Bearer test-tavily-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      query: "Prism Engine state space",
      search_depth: "advanced",
      max_results: 10,
      topic: "general",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_image_descriptions: false,
      include_favicon: false,
      time_range: "month",
      start_date: "2026-01-01",
      end_date: "2026-02-01",
      include_domains: ["example.com", "tavily.com"],
      exclude_domains: ["spam.example"],
    });
  });

  test("reports missing Tavily key as a tool failure", async () => {
    const configDir = await makeConfigDir("web-search-missing-key");
    const result = await executeWebSearchTool(
      { id: "call-2", name: "web_search", arguments: JSON.stringify({ query: "news" }) },
      { env: { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") } },
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("TAVILY_API_KEY");
  });
});

describe("web_fetch tool", () => {
  test("calls Tavily Extract and returns bounded markdown content", async () => {
    const configDir = await makeConfigDir("web-fetch-ok");
    await writeFile(join(configDir, ".env"), "TAVILY_API_KEY=test-tavily-key\n", "utf8");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await executeWebFetchTool(
      {
        id: "call-3",
        name: "web_fetch",
        arguments: JSON.stringify({
          url: "https://example.com/source",
          maxChars: 12,
          extractDepth: "advanced",
          format: "text",
          query: "state space",
        }),
      },
      {
        env: { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") },
        fetchImpl: (async (url, init) => {
          requests.push({ url: String(url), init: init ?? {} });
          return Response.json({
            results: [
              {
                url: "https://example.com/source",
                raw_content: "0123456789abcdef",
              },
            ],
            failed_results: [],
          });
        }) as typeof fetch,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.webEvent).toEqual({
      kind: "web_fetch",
      provider: "tavily",
      urls: ["https://example.com/source"],
      chars: 12,
      truncated: true,
    });
    expect(JSON.parse(result.content)).toMatchObject({
      results: [{
        url: "https://example.com/source",
        content: "0123456789a…",
      }],
      truncated: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.tavily.com/extract");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      urls: ["https://example.com/source"],
      extract_depth: "advanced",
      include_images: false,
      include_favicon: false,
      format: "text",
      include_usage: false,
      query: "state space",
    });
  });

  test("rejects non-http URLs before calling Tavily", async () => {
    const configDir = await makeConfigDir("web-fetch-bad-url");
    await writeFile(join(configDir, ".env"), "TAVILY_API_KEY=test-tavily-key\n", "utf8");
    let called = false;
    const result = await executeWebFetchTool(
      { id: "call-4", name: "web_fetch", arguments: JSON.stringify({ url: "file:///etc/passwd" }) },
      {
        env: { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") },
        fetchImpl: (async () => {
          called = true;
          return Response.json({});
        }) as unknown as typeof fetch,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain("http:// or https://");
    expect(called).toBe(false);
  });
});

describe("web_map tool", () => {
  test("calls Tavily Map with bounded traversal parameters", async () => {
    const configDir = await makeConfigDir("web-map-ok");
    await writeFile(join(configDir, ".env"), "TAVILY_API_KEY=test-tavily-key\n", "utf8");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await executeWebMapTool(
      {
        id: "call-5",
        name: "web_map",
        arguments: JSON.stringify({
          url: "https://docs.example.com",
          maxDepth: 5,
          maxBreadth: 999,
          limit: 999,
          allowedDomains: ["^docs\\.example\\.com$"],
          allowedPaths: ["/guide/.*"],
          allowExternal: true,
        }),
      },
      {
        env: { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") },
        fetchImpl: (async (url, init) => {
          requests.push({ url: String(url), init: init ?? {} });
          return Response.json({
            results: ["https://docs.example.com/guide/a", "https://docs.example.com/guide/b"],
          });
        }) as typeof fetch,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.webEvent).toEqual({
      kind: "web_map",
      provider: "tavily",
      url: "https://docs.example.com/",
      resultCount: 2,
      urls: ["https://docs.example.com/guide/a", "https://docs.example.com/guide/b"],
    });
    expect(requests[0].url).toBe("https://api.tavily.com/map");
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      url: "https://docs.example.com/",
      max_depth: 3,
      max_breadth: 50,
      limit: 100,
      allow_external: true,
      select_domains: ["^docs\\.example\\.com$"],
      select_paths: ["/guide/.*"],
      include_usage: false,
    });
  });
});

describe("web_crawl tool", () => {
  test("calls Tavily Crawl and bounds extracted content", async () => {
    const configDir = await makeConfigDir("web-crawl-ok");
    await writeFile(join(configDir, ".env"), "TAVILY_API_KEY=test-tavily-key\n", "utf8");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await executeWebCrawlTool(
      {
        id: "call-6",
        name: "web_crawl",
        arguments: JSON.stringify({
          url: "https://docs.example.com",
          maxChars: 8,
        }),
      },
      {
        env: { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") },
        fetchImpl: (async (url, init) => {
          requests.push({ url: String(url), init: init ?? {} });
          return Response.json({
            results: [
              { url: "https://docs.example.com/a", raw_content: "0123456789" },
              { url: "https://docs.example.com/b", raw_content: "abcdef" },
            ],
          });
        }) as typeof fetch,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.webEvent).toEqual({
      kind: "web_crawl",
      provider: "tavily",
      url: "https://docs.example.com/",
      pageCount: 1,
      urls: ["https://docs.example.com/a"],
      chars: 8,
      truncated: true,
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      url: "https://docs.example.com/",
      max_depth: 1,
      max_breadth: 10,
      limit: 10,
      allow_external: false,
      extract_depth: "basic",
      format: "markdown",
    });
  });
});

describe("web_research tool", () => {
  test("queues and polls Tavily Research before returning a bounded cited report", async () => {
    const configDir = await makeConfigDir("web-research-ok");
    await writeFile(join(configDir, ".env"), "TAVILY_API_KEY=test-tavily-key\n", "utf8");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await executeWebResearchTool(
      {
        id: "call-7",
        name: "web_research",
        arguments: JSON.stringify({
          input: "Compare Prism and Vesicle",
          model: "pro",
          outputLength: "short",
          includeDomains: ["example.com"],
          excludeDomains: ["spam.example"],
          maxChars: 12,
          timeoutSeconds: 5,
        }),
      },
      {
        env: { VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml") },
        pollIntervalMs: 1,
        fetchImpl: (async (url, init) => {
          requests.push({ url: String(url), init: init ?? {} });
          if (String(url).endsWith("/research")) {
            return Response.json({ request_id: "research-1", status: "pending" }, { status: 201 });
          }
          return Response.json({
            request_id: "research-1",
            status: "completed",
            content: "0123456789abcdef",
            sources: [{ title: "Source", url: "https://example.com/source" }],
          });
        }) as typeof fetch,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.webEvent).toEqual({
      kind: "web_research",
      provider: "tavily",
      input: "Compare Prism and Vesicle",
      requestId: "research-1",
      sourceCount: 1,
      urls: ["https://example.com/source"],
      chars: 12,
      truncated: true,
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.tavily.com/research",
      "https://api.tavily.com/research/research-1",
    ]);
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      input: "Compare Prism and Vesicle",
      model: "pro",
      stream: false,
      citation_format: "numbered",
      output_length: "short",
      include_domains: ["example.com"],
      exclude_domains: ["spam.example"],
    });
    expect(JSON.parse(result.content)).toMatchObject({
      requestId: "research-1",
      report: "0123456789a…",
      sources: [{ title: "Source", url: "https://example.com/source" }],
      truncated: true,
    });
  });
});

async function makeConfigDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `vesicle-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

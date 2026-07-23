import type { ToolDefinition } from "../types";

export const webSearchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the live web through Tavily and return cited results for research. Use web_fetch for full page content and file tools to persist synthesized notes under source_materials/.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Be specific enough to retrieve source material, not a generic topic label.",
        },
        maxResults: {
          type: "number",
          description: "Maximum result count. Defaults to 5 and is capped at 10.",
        },
        searchDepth: {
          type: "string",
          enum: ["basic", "advanced", "fast", "ultra-fast"],
          description: "Latency/relevance tradeoff. Defaults to basic; use advanced for high-confidence evidence gathering.",
        },
        topic: {
          type: "string",
          enum: ["general", "news", "finance"],
          description: "Search category. Defaults to general.",
        },
        timeRange: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional recency filter.",
        },
        startDate: {
          type: "string",
          description: "Optional YYYY-MM-DD lower date bound.",
        },
        endDate: {
          type: "string",
          description: "Optional YYYY-MM-DD upper date bound.",
        },
        country: {
          type: "string",
          description: "Optional country boost for general searches, such as united states or japan.",
        },
        allowedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to restrict Tavily search to, such as example.com.",
        },
        blockedDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to exclude from Tavily search.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const webFetchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_fetch",
    description: "Fetch and extract readable content from one or more URLs through Tavily Extract. Use this after web_search or web_map identifies sources worth reading.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Single HTTP or HTTPS URL to fetch. Use urls for batches.",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "HTTP or HTTPS URLs to fetch. Capped at 5 per call.",
        },
        maxChars: {
          type: "number",
          description: "Maximum extracted content characters to return across all URLs. Defaults to 6000 and is capped at 12000.",
        },
        extractDepth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "Extraction depth. Defaults to basic; advanced may retrieve tables or embedded content with higher latency/cost.",
        },
        format: {
          type: "string",
          enum: ["markdown", "text"],
          description: "Output format. Defaults to markdown.",
        },
        query: {
          type: "string",
          description: "Optional relevance query for chunk reranking during extraction.",
        },
      },
      additionalProperties: false,
    },
  },
};

export const webMapToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_map",
    description: "Map a website's URL structure through Tavily before deciding which pages to fetch or crawl.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS root URL to map." },
        instructions: { type: "string", description: "Optional natural-language guidance for which pages to discover." },
        maxDepth: { type: "number", description: "Maximum link depth. Defaults to 1 and is capped at 3." },
        maxBreadth: { type: "number", description: "Maximum links to follow per page. Defaults to 20 and is capped at 50." },
        limit: { type: "number", description: "Maximum URLs to return. Defaults to 20 and is capped at 100." },
        allowExternal: { type: "boolean", description: "Whether to include external links. Defaults to false." },
        allowedDomains: { type: "array", items: { type: "string" }, description: "Optional domain regexes to include." },
        allowedPaths: { type: "array", items: { type: "string" }, description: "Optional path regexes to include, such as /docs/.*." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const webCrawlToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_crawl",
    description: "Crawl and extract bounded content from multiple pages on a website through Tavily. Prefer web_map first when the useful paths are unknown.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS root URL to crawl." },
        instructions: { type: "string", description: "Optional natural-language guidance for which pages to return." },
        maxDepth: { type: "number", description: "Maximum link depth. Defaults to 1 and is capped at 3." },
        maxBreadth: { type: "number", description: "Maximum links to follow per page. Defaults to 10 and is capped at 30." },
        limit: { type: "number", description: "Maximum pages to crawl. Defaults to 10 and is capped at 30." },
        allowExternal: { type: "boolean", description: "Whether to include external links. Defaults to false." },
        allowedDomains: { type: "array", items: { type: "string" }, description: "Optional domain regexes to include." },
        allowedPaths: { type: "array", items: { type: "string" }, description: "Optional path regexes to include, such as /docs/.*." },
        maxChars: { type: "number", description: "Maximum extracted content characters to return across all pages. Defaults to 12000 and is capped at 30000." },
        extractDepth: { type: "string", enum: ["basic", "advanced"], description: "Extraction depth. Defaults to basic." },
        format: { type: "string", enum: ["markdown", "text"], description: "Output format. Defaults to markdown." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

export const webResearchToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "web_research",
    description: "Run a bounded Tavily Research task that searches, analyzes sources, and returns a cited synthesis. Use for broad comparisons or decision-ready reports.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Research task or question to investigate." },
        model: { type: "string", enum: ["mini", "pro", "auto"], description: "Research model. Defaults to mini; use pro only for broad multi-angle research." },
        citationFormat: { type: "string", enum: ["numbered", "mla", "apa", "chicago"], description: "Citation style. Defaults to numbered." },
        outputLength: { type: "string", enum: ["short", "standard", "long"], description: "Target response size. Defaults to standard." },
        includeDomains: { type: "array", items: { type: "string" }, description: "Soft preferred source domains. Capped at 20." },
        excludeDomains: { type: "array", items: { type: "string" }, description: "Source domains to avoid. Capped at 20." },
        maxChars: { type: "number", description: "Maximum report characters returned. Defaults to 12000 and is capped at 30000." },
        timeoutSeconds: { type: "number", description: "Maximum time to wait for the research task. Defaults to 45 and is capped at 120." },
      },
      required: ["input"],
      additionalProperties: false,
    },
  },
};

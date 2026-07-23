export type FetchLike = typeof fetch;

type SearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";
type ExtractDepth = "basic" | "advanced";
type WebContentFormat = "markdown" | "text";
type TimeRange = "day" | "week" | "month" | "year";
type SearchTopic = "general" | "news" | "finance";
type ResearchModel = "mini" | "pro" | "auto";
type CitationFormat = "numbered" | "mla" | "apa" | "chicago";
type ResearchOutputLength = "short" | "standard" | "long";

export type WebSearchArgs = {
  query: string;
  maxResults?: number;
  searchDepth?: SearchDepth;
  topic?: SearchTopic;
  timeRange?: TimeRange;
  startDate?: string;
  endDate?: string;
  country?: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
};

export type WebFetchArgs = {
  url?: string;
  urls?: string[];
  maxChars?: number;
  extractDepth?: ExtractDepth;
  format?: WebContentFormat;
  query?: string;
};

export type WebMapArgs = {
  url: string;
  instructions?: string;
  maxDepth?: number;
  maxBreadth?: number;
  limit?: number;
  allowExternal?: boolean;
  allowedDomains?: string[];
  allowedPaths?: string[];
};

export type WebCrawlArgs = WebMapArgs & {
  maxChars?: number;
  extractDepth?: ExtractDepth;
  format?: WebContentFormat;
};

export type WebResearchArgs = {
  input: string;
  model?: ResearchModel;
  citationFormat?: CitationFormat;
  outputLength?: ResearchOutputLength;
  includeDomains?: string[];
  excludeDomains?: string[];
  maxChars?: number;
  timeoutSeconds?: number;
};

export type TavilyResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  raw_content?: unknown;
  score?: unknown;
  published_date?: unknown;
  favicon?: unknown;
};

export type TavilySearchResponse = {
  query?: unknown;
  results?: unknown;
};

export type TavilyExtractResult = {
  url?: unknown;
  raw_content?: unknown;
  favicon?: unknown;
};

export type TavilyExtractResponse = {
  results?: unknown;
  failed_results?: unknown;
};

export type TavilyMapResponse = {
  base_url?: unknown;
  results?: unknown;
};

export type TavilyResearchQueued = {
  request_id?: unknown;
  status?: unknown;
};

export type TavilyResearchResponse = {
  request_id?: unknown;
  status?: unknown;
  content?: unknown;
  sources?: unknown;
};

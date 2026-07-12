export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type FileToolEvent = {
  kind: "file_operation";
  operation:
    | "stat"
    | "list"
    | "grep"
    | "read"
    | "view"
    | "create"
    | "write"
    | "replace"
    | "append"
    | "delete"
    | "copy"
    | "move";
  path?: string;
  sourcePath?: string;
  targetPath?: string;
  changed: boolean;
  /** Size of the resulting or observed file, or the deleted file for delete_file. */
  bytes?: number;
  /** Bytes added by append_file. */
  deltaBytes?: number;
  lines?: number;
  /** grep_files hit count. */
  matches?: number;
  /** list_files entry count. */
  entryCount?: number;
  occurrences?: number;
  truncated?: boolean;
  /** 1-based start line of each matched occurrence (replace_in_file). */
  matchLines?: number[];
  /** @deprecated pre-rename sessions recorded a scalar; read for backward compat. */
  matchLineStart?: number;
};

export type WebToolEvent =
  | {
    kind: "web_search";
    provider: "tavily";
    query: string;
    resultCount: number;
    urls: string[];
  }
  | {
    kind: "web_fetch";
    provider: "tavily";
    urls: string[];
    chars: number;
    truncated: boolean;
  }
  | {
    kind: "web_map";
    provider: "tavily";
    url: string;
    resultCount: number;
    urls: string[];
  }
  | {
    kind: "web_crawl";
    provider: "tavily";
    url: string;
    pageCount: number;
    urls: string[];
    chars: number;
    truncated: boolean;
  }
  | {
    kind: "web_research";
    provider: "tavily";
    input: string;
    requestId: string;
    sourceCount: number;
    urls: string[];
    chars: number;
    truncated: boolean;
  };

export type McpToolEvent = {
  kind: "mcp_tool";
  serverId: string;
  alias: string;
  toolName: string;
  isError: boolean;
};

export type ToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  fileEvent?: FileToolEvent;
  webEvent?: WebToolEvent;
  mcpEvent?: McpToolEvent;
  images?: import("../../providers/shared/types").VesicleImageAttachment[];
};

export type FileToolExecutionOptions = {
  /** Called after path guards pass and immediately before a mutation. */
  beforeMutation?: (paths: string[]) => Promise<void>;
  /** Override the effective asset namespace, primarily for isolated runtimes/tests. */
  assets?: import("../runtime/assets").AssetResolver;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

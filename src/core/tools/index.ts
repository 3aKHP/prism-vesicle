export type BuiltInToolName =
  | "config.load"
  | "session.write"
  | "prompt.load"
  | "web_search"
  | "web_fetch"
  | "web_map"
  | "web_crawl"
  | "web_research"
  | "stat_path"
  | "list_files"
  | "grep_files"
  | "read_file"
  | "view_image"
  | "create_file"
  | "write_file"
  | "replace_in_file"
  | "append_file"
  | "delete_file"
  | "copy_file"
  | "move_file";
import { executeFileTool, fileToolDefinitions } from "./fs";
import {
  executeWebCrawlTool,
  executeWebFetchTool,
  executeWebMapTool,
  executeWebResearchTool,
  executeWebSearchTool,
  webCrawlToolDefinition,
  webFetchToolDefinition,
  webMapToolDefinition,
  webResearchToolDefinition,
  webSearchToolDefinition,
} from "./web";
import type { FileToolExecutionOptions, ToolCall, ToolDefinition, ToolResult } from "./types";

export { executeFileTool, fileToolDefinitions } from "./fs";
export {
  executeWebCrawlTool,
  executeWebFetchTool,
  executeWebMapTool,
  executeWebResearchTool,
  executeWebSearchTool,
  webCrawlToolDefinition,
  webFetchToolDefinition,
  webMapToolDefinition,
  webResearchToolDefinition,
  webSearchToolDefinition,
} from "./web";
export type { AgentToolEvent, FileToolEvent, FileToolExecutionOptions, McpToolEvent, ToolCall, ToolDefinition, ToolResult, WebToolEvent } from "./types";

export type ToolContract = {
  name: BuiltInToolName;
  description: string;
};

export const m0Tools: ToolContract[] = [
  {
    name: "config.load",
    description: "Load Vesicle provider configuration from environment variables.",
  },
  {
    name: "session.write",
    description: "Append a JSONL record to the current Vesicle session.",
  },
  {
    name: "prompt.load",
    description: "Load Prism prompt assets from the assets directory.",
  },
  {
    name: "web_search",
    description: "Search the live web through Tavily for research material.",
  },
  {
    name: "web_fetch",
    description: "Fetch and extract readable content from a URL through Tavily.",
  },
  {
    name: "web_map",
    description: "Map a website's URL structure through Tavily.",
  },
  {
    name: "web_crawl",
    description: "Crawl bounded website content through Tavily.",
  },
  {
    name: "web_research",
    description: "Run a bounded Tavily research task and return a cited synthesis.",
  },
  {
    name: "stat_path",
    description: "Inspect an allowed project path.",
  },
  {
    name: "list_files",
    description: "List allowed project files.",
  },
  {
    name: "grep_files",
    description: "Search text in allowed project files.",
  },
  {
    name: "read_file",
    description: "Read allowed UTF-8 project files.",
  },
  {
    name: "view_image",
    description: "Attach an allowed project image for visual inspection.",
  },
  {
    name: "create_file",
    description: "Create a new UTF-8 file under a writable project root without overwriting it.",
  },
  {
    name: "write_file",
    description: "Write UTF-8 files under source_materials, workspace, novels, reports, or test_runs.",
  },
  {
    name: "replace_in_file",
    description: "Replace exact text inside an existing writable project file.",
  },
  {
    name: "append_file",
    description: "Append UTF-8 text to an existing writable project file.",
  },
  {
    name: "delete_file",
    description: "Delete a file under a writable project root.",
  },
  {
    name: "copy_file",
    description: "Copy an allowed file into a writable project root.",
  },
  {
    name: "move_file",
    description: "Move or rename a file inside writable project roots.",
  },
];

export const hostToolDefinitions: ToolDefinition[] = [
  ...fileToolDefinitions,
  webSearchToolDefinition,
  webFetchToolDefinition,
  webMapToolDefinition,
  webCrawlToolDefinition,
  webResearchToolDefinition,
];

export async function executeHostTool(
  rootDir: string,
  call: ToolCall,
  options: FileToolExecutionOptions = {},
): Promise<ToolResult> {
  if (call.name === "web_search") return executeWebSearchTool(call);
  if (call.name === "web_fetch") return executeWebFetchTool(call);
  if (call.name === "web_map") return executeWebMapTool(call);
  if (call.name === "web_crawl") return executeWebCrawlTool(call);
  if (call.name === "web_research") return executeWebResearchTool(call);
  return executeFileTool(rootDir, call, options);
}

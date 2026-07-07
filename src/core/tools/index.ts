export type BuiltInToolName =
  | "config.load"
  | "session.write"
  | "prompt.load"
  | "stat_path"
  | "list_files"
  | "grep_files"
  | "read_file"
  | "create_file"
  | "write_file"
  | "replace_in_file"
  | "append_file"
  | "delete_file"
  | "copy_file"
  | "move_file";
export { executeFileTool, fileToolDefinitions } from "./fs";
export type { FileToolEvent, ToolCall, ToolDefinition, ToolResult } from "./fs";

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
    name: "create_file",
    description: "Create a new UTF-8 artifact file without overwriting an existing file.",
  },
  {
    name: "write_file",
    description: "Write UTF-8 artifacts under workspace, test_runs, novels, or reports.",
  },
  {
    name: "replace_in_file",
    description: "Replace exact text inside an existing artifact file.",
  },
  {
    name: "append_file",
    description: "Append UTF-8 text to an existing artifact file.",
  },
  {
    name: "delete_file",
    description: "Delete an artifact file.",
  },
  {
    name: "copy_file",
    description: "Copy an allowed file into an artifact root.",
  },
  {
    name: "move_file",
    description: "Move or rename an artifact file inside artifact roots.",
  },
];

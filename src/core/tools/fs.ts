import { createAssetResolver } from "../runtime/assets";
import { executeFileMutationOperation } from "./file/mutation-handlers";
import { executeFileReadOperation } from "./file/read-handlers";
import type { FileToolExecutionOptions, ToolCall, ToolResult } from "./types";

export { fileToolDefinitions } from "./file/definitions";
export { readWritableProjectText } from "./file/mutation-handlers";

const readToolNames = new Set(["stat_path", "list_files", "list_directory", "grep_files", "read_file", "view_image"]);

export async function executeFileTool(
  rootDir: string,
  call: ToolCall,
  options: FileToolExecutionOptions = {},
): Promise<ToolResult> {
  const assets = options.assets ?? createAssetResolver(rootDir);
  try {
    return readToolNames.has(call.name)
      ? await executeFileReadOperation(rootDir, call, assets)
      : await executeFileMutationOperation(rootDir, call, options, assets);
  } catch (error) {
    return { callId: call.id, name: call.name, ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}

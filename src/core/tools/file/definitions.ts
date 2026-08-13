import type { ToolDefinition } from "../types";
import { readableFileRoots } from "./path-policy";

const readableRoots = readableFileRoots.join(", ");
const guardedReadPath = `Project-relative path beginning with one of: ${readableRoots}. Do not use '.' or absolute paths; paths outside these logical roots are rejected. Project-root VESICLE*.md files are host-managed Persistent Instructions, not file-tool paths.`;

export const fileToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "stat_path",
      description: "Inspect an allowed path. Missing paths are returned as a successful structured not_found observation.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: guardedReadPath,
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "Query the model-visible logical filesystem. Use path '.' to discover the safe logical roots; no host project files are exposed. Other paths must begin with a listed root. Results distinguish missing paths, non-directory targets, true empty directories, and truncation; fileCount/directoryCount/otherCount preserve directory shape even when detail is names.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Use '.' for the virtual root, or a directory beginning with one of: ${readableRoots}. Example: workspace or assets/templates.`,
          },
          recursive: {
            type: "boolean",
            description: "Whether to list descendants recursively. Defaults to false.",
          },
          detail: {
            type: "string",
            enum: ["full", "names"],
            description: "Output detail. 'full' returns typed entries and metadata (default); 'names' returns file paths only. For path '.', names returns the logical root names for discovery. Both modes return fileCount, directoryCount, otherCount, empty, and truncation metadata.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_files",
      description: "Search allowed UTF-8 project files for literal text or a JavaScript regular expression. Returns matching lines with optional context, or switch outputMode to list matching files or count hits per file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: guardedReadPath,
          },
          pattern: {
            type: "string",
            description: "Search pattern. Interpreted literally unless regex is true.",
          },
          regex: {
            type: "boolean",
            description: "Treat pattern as a JavaScript regular expression. Defaults to false.",
          },
          caseSensitive: {
            type: "boolean",
            description: "Whether matching is case-sensitive. Defaults to false.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to search directories recursively. Defaults to true.",
          },
          maxMatches: {
            type: "number",
            description: "Maximum matches to return. Defaults to 50 and is capped at 200. In files_with_matches and count modes, limits the number of files instead.",
          },
          contextLines: {
            type: "number",
            description: "Lines of context to show before and after each match. Defaults to 0 (no context). Capped at 10. Only affects outputMode 'content'.",
          },
          outputMode: {
            type: "string",
            enum: ["content", "files_with_matches", "count"],
            description: "Output shape. 'content' returns match entries with text (default). 'files_with_matches' returns only file paths that contain matches. 'count' returns per-file match counts.",
          },
        },
        required: ["path", "pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from an allowed Vesicle project directory. Use startLine/endLine to read a line range, or offsetBytes/maxBytes to read a bounded byte slice without loading the whole file (preferred for very large files or giant single-line payloads).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: guardedReadPath,
          },
          startLine: {
            type: "number",
            description: "Optional 1-based first line to read (ignored when maxBytes is given).",
          },
          endLine: {
            type: "number",
            description: "Optional 1-based last line to read, inclusive (ignored when maxBytes is given).",
          },
          offsetBytes: {
            type: "number",
            description: "Optional non-negative byte offset for a bounded slice read (requires maxBytes; project files only).",
          },
          maxBytes: {
            type: "number",
            description: "Optional maximum bytes to read from offsetBytes. When set, reads a bounded byte slice (project files only) instead of a line range and never loads the whole file.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description: "View an image under an allowed project root. Use this for visual inspection of files in source_materials, workspace, assets, novels, reports, test_runs, or tmp (scratch).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: guardedReadPath,
          },
          detail: {
            type: "string",
            enum: ["auto", "high", "original"],
            description: "Image detail hint. Defaults to auto.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new UTF-8 project file. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
          content: {
            type: "string",
            description: "Full UTF-8 file content to write.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "Create a directory under a writable project root. Fails if the target already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative directory path below source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
          recursive: {
            type: "boolean",
            description: "Create missing parent directories. Defaults to true.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 project file under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative output path, such as source_materials/research.md or workspace/luotianyi.md.",
          },
          content: {
            type: "string",
            description: "Full UTF-8 file content to write.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Replace exact text inside an existing writable UTF-8 project file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
          oldText: {
            type: "string",
            description: "Exact text to replace.",
          },
          newText: {
            type: "string",
            description: "Replacement text.",
          },
          replaceAll: {
            type: "boolean",
            description: "Replace every occurrence. Defaults to false; without it, exactly one occurrence must match.",
          },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_file",
      description: "Append UTF-8 text to an existing writable project file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
          content: {
            type: "string",
            description: "UTF-8 content to append.",
          },
          createIfMissing: {
            type: "boolean",
            description: "Create the file if it does not exist. Defaults to false.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a single writable project file. Directories are not deleted.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copy_file",
      description: "Copy an allowed file to a writable project root.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Project-relative source file path under an allowed read root.",
          },
          targetPath: {
            type: "string",
            description: "Project-relative target path under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
          overwrite: {
            type: "boolean",
            description: "Overwrite an existing target file. Defaults to false.",
          },
        },
        required: ["sourcePath", "targetPath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "Move or rename a file inside writable project roots.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Project-relative source file path under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
          targetPath: {
            type: "string",
            description: "Project-relative target path under source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
          overwrite: {
            type: "boolean",
            description: "Overwrite an existing target file. Defaults to false.",
          },
        },
        required: ["sourcePath", "targetPath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_directory",
      description: "Move or rename a directory tree inside writable project roots. The target must not exist.",
      parameters: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Existing project-relative directory path below a writable root.",
          },
          targetPath: {
            type: "string",
            description: "New project-relative directory path below a writable root.",
          },
        },
        required: ["sourcePath", "targetPath"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_directory",
      description: "Delete one empty directory below a writable project root. Fixed writable roots and non-empty directories are refused.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative empty directory path below source_materials, workspace, novels, reports, test_runs, or tmp (scratch).",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

import type { ToolDefinition } from "../types";

export const fileToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "stat_path",
      description: "Inspect an allowed project-relative file or directory path.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative path under an allowed read root.",
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
      name: "list_files",
      description: "List files under an allowed Vesicle project directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative directory path, such as source_materials or workspace.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to list files recursively. Defaults to false.",
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
      description: "List files, directories, and symbolic links under an allowed Vesicle project directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative directory path, such as workspace or workspace/part_01.",
          },
          recursive: {
            type: "boolean",
            description: "Whether to list descendants recursively. Defaults to false.",
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
      description: "Search allowed UTF-8 project files for literal text or a JavaScript regular expression.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file or directory path under an allowed read root.",
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
            description: "Maximum matches to return. Defaults to 50 and is capped at 200.",
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
      description: "Read a UTF-8 text file from an allowed Vesicle project directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative file path.",
          },
          startLine: {
            type: "number",
            description: "Optional 1-based first line to read.",
          },
          endLine: {
            type: "number",
            description: "Optional 1-based last line to read, inclusive.",
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
      description: "View an image under an allowed project root. Use this for visual inspection of files in source_materials, workspace, assets, novels, reports, or test_runs.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Project-relative image path under an allowed read root.",
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
            description: "Project-relative output path under source_materials, workspace, novels, reports, or test_runs.",
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
            description: "Project-relative directory path below source_materials, workspace, novels, reports, or test_runs.",
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
      description: "Create or overwrite a UTF-8 project file under source_materials, workspace, novels, reports, or test_runs.",
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
            description: "Project-relative file path under source_materials, workspace, novels, reports, or test_runs.",
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
            description: "Project-relative file path under source_materials, workspace, novels, reports, or test_runs.",
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
            description: "Project-relative file path under source_materials, workspace, novels, reports, or test_runs.",
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
            description: "Project-relative target path under source_materials, workspace, novels, reports, or test_runs.",
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
            description: "Project-relative source file path under source_materials, workspace, novels, reports, or test_runs.",
          },
          targetPath: {
            type: "string",
            description: "Project-relative target path under source_materials, workspace, novels, reports, or test_runs.",
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
            description: "Project-relative empty directory path below source_materials, workspace, novels, reports, or test_runs.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

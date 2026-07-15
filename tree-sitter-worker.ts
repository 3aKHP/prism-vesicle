// This must remain a root-level compile entrypoint. See scripts/build-exe.ts
// for the Bun standalone Worker path contract.
// Force Bun to retain the parser runtime that OpenTUI imports from inside its
// worker. Without this explicit edge, the compiled worker can still resolve
// web-tree-sitter from a developer's node_modules but fails in a clean release
// directory.
import "web-tree-sitter";
import "./node_modules/@opentui/core/parser.worker.js";

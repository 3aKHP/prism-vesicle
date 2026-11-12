# CLI Commands

This directory contains configuration transactions, Skill lifecycle and authoring commands, prompt inspection, and the quality benchmark entry point. Startup routing and other commands live in the parent `src/cli/` modules.

The public command surface and usage are documented in [the CLI reference](../../../docs/user/en/reference/cli-commands.md). Keep parsers and help text aligned with that reference; command modules delegate runtime behavior to the owning configuration, core, provider, or diagnostic domain.

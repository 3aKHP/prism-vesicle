# Rust Development

The experimental root Cargo workspace is separate from the supported TypeScript product. Its crates live under `rust/`; its command is `vesicle-rust-dev`, with `publish = false`. The `2.0.0-dev.1` Cargo version identifies this development artifact, not a published release or a claim of product compatibility. npm, installers and the stable `vesicle` entry continue to use the TypeScript runtime.

## Current Surface

`rust/cli` dispatches `--help` / `-h`, `--version` / `-V`, and `inspect-session FILE [--head UUID]`. No arguments show help. Unsupported commands or extra arguments exit with code 2. Inspection errors exit 1, emit a JSON error code and optional source line on stderr, and emit no success document. Output-write failures also exit 1.

The inspection command reads a regular UTF-8 JSONL file, bounded to 16 MiB. It accepts an explicit host path, including an absolute path; it is a developer command, not a model-visible path-guarded tool. It does not load host configuration, contact providers, write a session, restore files or run a TS backend. The pure `rust/session` library owns normalization, branch selection and preference projection; the CLI owns file I/O. Future TUI consumers must call domain/host interfaces rather than own persistence or permissions.

### Supported inspection subset

The JSON result has `schemaVersion: 1`, `mode: "read-only-inspection"`, all normalized `records`, `activeBranch`, `hostPreferences`, and `attachmentsVerified: false`. Missing legacy UUIDs become `<sessionId>:legacy:<record-index>`; missing parents follow the preceding record. Candidate markers must point to a content leaf and name its nearest owning user turn. Explicit `--head` selects that record's ancestor chain; the default follows the physical tail. Host engine/provider/model/reasoning/permission preferences instead follow the full physical order, including records outside the selected branch. Reading a recorded permission mode never activates it.

Untagged system/user/assistant records and the system kinds `candidate-selection`, `provider-switch`, `engine-switch`, `thinking-switch`, `reasoning-switch`, and `permission-mode-switch` are supported. Metadata and opaque JSON values are preserved. Provider-state envelopes receive version/owner/size/depth validation without interpreting their payload. Attachment references are retained as metadata; bytes, hashes, availability and file manifests are **not** validated or materialized. This output is a record inspection, not provider-ready history or permission to resume.

Tool-result records and metadata containing tool calls fail explicitly, so unfinished interactions cannot be mistaken for a supported history. Other kinds (including compaction, migration/Skill rebind, pending interactions and candidate file snapshots) also fail explicitly. Malformed records, mixed session identities, duplicate IDs, missing/forward parents and cycles are rejected, including on unselected branches. This prototype's backward-link and 16 MiB restrictions are explicit inspection limits, not a claim of full stable-version compatibility. Original files are never rewritten. Full semantic recovery, adjacent-data verification and append-only continuation remain separate work.

## Build And Verification

Install [rustup](https://rust-lang.github.io/rustup/installation/index.html), then run from the repository root:

```sh
rustup toolchain install 1.96.1 --profile minimal --component rustfmt --component clippy
cargo run --locked -p vesicle-cli --bin vesicle-rust-dev -- --help
bun scripts/check/rust-workspace.ts
```

`rust-toolchain.toml` pins Rust 1.96.1, already exercised by the repository's compiler-routing checks; it is the only toolchain claimed as verified for this workspace. `rust-version` declares the same requirement. Future dependency choices may require an explicitly reviewed update; no claim is made that this is the latest Rust release. The [official distribution manifest](https://static.rust-lang.org/dist/channel-rust-1.96.1.toml) identifies the toolchain. The root [Cargo workspace](https://doc.rust-lang.org/cargo/reference/workspaces.html) shares a lockfile and `target/` output directory, with edition 2024 and explicit resolver 3.

The verification script selects the pinned compiler explicitly and rejects tracked manifests outside the workspace. It runs locked metadata, formatting, Clippy with warnings denied, and all workspace targets' tests. Stage new workspace inputs before running the script, because applicability is derived from Git's tracked files. CI installs the pin and runs this same command on Linux and native Windows. Integration tests start the compiled executable, check its development identity, and reject unsupported workflow attempts. The additional `bun scripts/smoke/migration/rust-session.ts` lane compares normalized records and selected branches with the existing TS functions using the synthetic corpus, exercises errors through the native CLI, and checks that the original corpus tree remains unchanged. It runs on both native CI platforms. CI retains debug binaries as development artifacts only.

The session library uses [serde_json 1.0.154](https://docs.rs/serde_json/1.0.154/serde_json/) with `arbitrary_precision` to avoid rounding opaque JSON numbers. Containers are decoded through borrowed `raw_value` children so literal object keys cannot collide with serde's private numeric tag; nesting is bounded below 128 levels. Direct versions are pinned in the workspace and transitive versions/checksums in `Cargo.lock`; it introduces no TUI, network or provider SDK dependency.

These checks establish a usable build, command-entry boundary and the documented read-only inspection subset. They do not establish provider streaming, history compatibility, candidate restoration, terminal editing, native Windows filesystem/process behavior, performance or release readiness. Those require their own implementations and observable acceptance evidence.

<!-- Generated from docs/dev/RUST_DEVELOPMENT.md — do not edit. -->

# Rust Development

The experimental root Cargo workspace is separate from the supported TypeScript product. Its crates live under `rust/`; its command is `vesicle-rust-dev`, with `publish = false`. The `2.0.0-dev.1` Cargo version identifies this development artifact, not a published release or a claim of product compatibility. npm, installers and the stable `vesicle` entry continue to use the TypeScript runtime.

## Current Surface

`rust/cli` dispatches `--help` / `-h`, `--version` / `-V`, `inspect-session FILE [--head UUID]`, and `verify-attachments PROJECT FILE [--head UUID]`. No arguments show help. Unsupported commands or extra arguments exit with code 2. Inspection errors exit 1, emit a JSON error code and optional source line on stderr, and emit no success document. Output-write failures also exit 1.

The inspection command reads a regular UTF-8 JSONL file, bounded to 16 MiB. It accepts an explicit host path, including an absolute path; it is a developer command, not a model-visible path-guarded tool. It does not load host configuration, contact providers, write a session, restore files or run a TS backend. The pure `rust/session` library owns normalization, branch selection and persisted host-state projection; the CLI owns session-file I/O. `rust/attachments` owns bounded, read-only attachment verification. Future TUI consumers must call domain/host interfaces rather than own persistence or permissions.

### Supported inspection subset

The JSON result has `schemaVersion: 1`, `mode: "read-only-inspection"`, all normalized `records`, `activeBranch`, `hostPreferences`, additive `hostState`, and `attachmentsVerified: false`. Missing legacy UUIDs become `<sessionId>:legacy:<record-index>`; missing parents follow the preceding record. Candidate markers must point to a content leaf and name its nearest owning user turn. Explicit `--head` selects that record's ancestor chain; the default follows the physical tail. Host engine/provider/model/reasoning/permission preferences instead follow the full physical order, including records outside the selected branch. Reading a recorded permission mode never activates it.

Untagged system/user/assistant records and the system kinds `candidate-selection`, `provider-switch`, `engine-switch`, `thinking-switch`, `reasoning-switch`, `permission-mode-switch`, `session-migration`, and `skill-catalog` are supported. Metadata and opaque JSON values are preserved. Provider-state envelopes receive version/owner/size/depth validation without interpreting their payload. In `inspect-session`, attachment references are retained as metadata; bytes, hashes, availability and file manifests are **not** validated or materialized. Use the explicit verification command below to check attachment-store bytes. This output is a record inspection, not provider-ready history or permission to resume.

Tool-result records and metadata containing tool calls fail explicitly, so unfinished interactions cannot be mistaken for a supported history. Other kinds (including compaction, pending interactions and candidate file snapshots) also fail explicitly. Malformed records, mixed session identities, duplicate IDs, missing/forward parents and cycles are rejected, including on unselected branches. This prototype's backward-link and 16 MiB restrictions are explicit inspection limits, not a claim of full stable-version compatibility. Original files are never rewritten. Full semantic recovery, other adjacent-data verification and append-only continuation remain separate work.

### Persisted migration identity and Skill state

`hostState` extends the existing `hostPreferences` with the effective persisted `harness` and last valid `skillCatalogSnapshot`. The initial system identity is the fallback; the last valid required `session-migration` envelope in physical order rebinds it, even when `--head` selects an older branch. Identity fields follow the TS persisted patterns; malformed required identity/migration data fails the entire inspection. The archive path is metadata only and is never opened. Invalid optional Skill snapshots are ignored, retaining the last valid snapshot as the TS projector does. Raw records retain both valid and invalid optional metadata unchanged. This does not validate installed Harness files, resolve Skill bodies, activate Skills or perform a migration transaction.

### Explicit attachment integrity verification

`verify-attachments PROJECT FILE [--head UUID]` performs the same inspection, then checks `metadata.images` across **all physical records**, including inactive branches. It accepts only canonical `.vesicle/attachments/<sha256>.<extension>` references, validates declared size, SHA-256 and the PNG/JPEG/GIF/WebP signature, and rejects inline image data. Missing, changed or malformed references produce an error and no success document. A successful result sets `attachmentsVerified: true` and adds `attachmentVerification` counts for references, unique files and verified bytes; an empty reference set reports zero. It does not emit image bytes, create base64 provider messages, inspect arbitrary opaque provider payloads, or verify other adjacent file manifests.

Verification allows at most 1024 references, 20 MiB per file and 100 MiB of unique verified bytes. Reads are bounded and duplicate references share one file check. Components beneath the explicitly selected project root reject symlinks and Windows reparse points (including junctions); canonical containment is checked as well. The selected root itself may be resolved from a user-supplied path. This is an inspection of a quiescent local store, **not** an atomic filesystem capability against concurrent directory replacement, a model-tool path guard, or permission to restore files. Future model-visible access must use the owning tool/path-guard boundary.

## Build And Verification

Install [rustup](https://rust-lang.github.io/rustup/installation/index.html), then run from the repository root:

```sh
rustup toolchain install 1.96.1 --profile minimal --component rustfmt --component clippy
cargo run --locked -p vesicle-cli --bin vesicle-rust-dev -- --help
bun scripts/check/rust-workspace.ts
```

`rust-toolchain.toml` pins Rust 1.96.1, already exercised by the repository's compiler-routing checks; it is the only toolchain claimed as verified for this workspace. `rust-version` declares the same requirement. Future dependency choices may require an explicitly reviewed update; no claim is made that this is the latest Rust release. The [official distribution manifest](https://static.rust-lang.org/dist/channel-rust-1.96.1.toml) identifies the toolchain. The root [Cargo workspace](https://doc.rust-lang.org/cargo/reference/workspaces.html) shares a lockfile and `target/` output directory, with edition 2024 and explicit resolver 3.

The verification script selects the pinned compiler explicitly and rejects tracked manifests outside the workspace. It runs locked metadata, formatting, Clippy with warnings denied, and all workspace targets' tests. Stage new workspace inputs before running the script, because applicability is derived from Git's tracked files. CI installs the pin and runs this same command on Linux and native Windows. Integration tests start the compiled executable, check its development identity, and reject unsupported workflow attempts. The additional `bun scripts/smoke/migration/rust-session.ts` lane compares normalized records and selected branches with the existing TS functions using the synthetic corpus, exercises errors through the native CLI, and checks that the original corpus tree remains unchanged. It runs on both native CI platforms. `bun scripts/smoke/migration/rust-attachments.ts` additionally exercises actual size/hash/media errors, aggregate/reference limits, unchanged input files and native directory-link rejection; Windows uses an actual junction. Unix file-symlink checks are reported separately and are not claimed as Windows evidence. CI retains debug binaries as development artifacts only.

The session library uses [serde_json 1.0.154](https://docs.rs/serde_json/1.0.154/serde_json/) with `arbitrary_precision` to avoid rounding opaque JSON numbers. Containers are decoded through borrowed `raw_value` children so literal object keys cannot collide with serde's private numeric tag; nesting is bounded below 128 levels. The attachment verifier uses [RustCrypto sha2 0.11.1](https://docs.rs/sha2/0.11.1/sha2/) for streaming SHA-256. Direct versions are pinned in the workspace and transitive versions/checksums in `Cargo.lock`; it introduces no TUI, network or provider SDK dependency.

These checks establish a usable build, command-entry boundary and the documented read-only inspection subset. They do not establish provider streaming, history compatibility, candidate restoration, terminal editing, native Windows filesystem/process behavior, performance or release readiness. Those require their own implementations and observable acceptance evidence.

# Rust Development

The experimental root Cargo workspace is separate from the supported TypeScript product. Its crates live under `rust/`; its command is `vesicle-rust-dev`, with `publish = false`. The `2.0.0-dev.1` Cargo version identifies this development artifact, not a published release or a claim of product compatibility. npm, installers and the stable `vesicle` entry continue to use the TypeScript runtime.

## Current Surface

`rust/cli` is a command dispatcher with `--help` / `-h` and `--version` / `-V`. No arguments show help. Unsupported commands or extra arguments exit with code 2 and no success output; an output-write failure exits with code 1. It does not load user configuration, contact providers, read/write sessions, initialize a terminal UI or run a TS backend. It currently has no third-party Cargo dependencies. Domain crates will be introduced with actual behavior rather than empty framework stubs.

## Build And Verification

Install [rustup](https://rust-lang.github.io/rustup/installation/index.html), then run from the repository root:

```sh
rustup toolchain install 1.96.1 --profile minimal --component rustfmt --component clippy
cargo run --locked -p vesicle-cli --bin vesicle-rust-dev -- --help
bun scripts/check/rust-workspace.ts
```

`rust-toolchain.toml` pins Rust 1.96.1, already exercised by the repository's compiler-routing checks; it is the only toolchain claimed as verified for this workspace. `rust-version` declares the same requirement. Future dependency choices may require an explicitly reviewed update; no claim is made that this is the latest Rust release. The [official distribution manifest](https://static.rust-lang.org/dist/channel-rust-1.96.1.toml) identifies the toolchain. The root [Cargo workspace](https://doc.rust-lang.org/cargo/reference/workspaces.html) shares a lockfile and `target/` output directory, with edition 2024 and explicit resolver 3.

The verification script selects the pinned compiler explicitly and rejects tracked manifests outside the workspace. It runs locked metadata, formatting, Clippy with warnings denied, and all workspace targets' tests. Stage new workspace inputs before running the script, because applicability is derived from Git's tracked files. CI installs the pin and runs this same command on Linux and native Windows. Integration tests start the compiled executable, check its development identity, and reject unsupported workflow attempts. CI retains debug binaries as development artifacts only.

These checks establish a usable build and command-entry boundary. They do not establish provider streaming, history compatibility, candidate restoration, terminal editing, native Windows filesystem/process behavior, performance or release readiness. Those require their own implementations and observable acceptance evidence.

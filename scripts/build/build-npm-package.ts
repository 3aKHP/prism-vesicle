import solidPlugin from "@3akhp/opentui-solid/bun-plugin";
import { mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

const OUTPUT_DIRECTORY = join(import.meta.dir, "..", "..", "dist", "npm");
const OUTPUT_ENTRY = join(OUTPUT_DIRECTORY, "vesicle.mjs");
const METAFILE = join(OUTPUT_DIRECTORY, "vesicle.meta.json");
// Bundle the fork core JavaScript (@3akhp/opentui-core, which natively carries
// Markdown/TextTable selection colors and the worker-side escape fix) so every
// consumer channel shares one runtime. Native libraries, the parser worker,
// and web-tree-sitter remain runtime assets supplied by the pinned fork.
const EXTERNAL_RUNTIME_PACKAGES = [
  "@3akhp/opentui-core/parser.worker",
  "@3akhp/opentui-core-*",
  // The fork loader dynamically imports every platform variant at runtime:
  // the @3akhp/* fork packages for linux/win32 and the upstream darwin
  // packages. Leave all of them as runtime imports; the fork loader resolves
  // the installed platform package itself.
  "@opentui/core-*",
  "web-tree-sitter",
];

await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
await mkdir(OUTPUT_DIRECTORY, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "..", "src", "cli", "main.ts")],
  target: "bun",
  format: "esm",
  outdir: OUTPUT_DIRECTORY,
  naming: "vesicle.mjs",
  packages: "bundle",
  external: EXTERNAL_RUNTIME_PACKAGES,
  plugins: [solidPlugin],
  define: {
    VESICLE_NPM_BUNDLE: "true",
  },
  metafile: true,
  sourcemap: "none",
  minify: { syntax: true, whitespace: false, identifiers: false },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("npm runtime bundle failed.");
}
if (result.logs.length > 0) {
  for (const log of result.logs) console.error(log);
  throw new Error("npm runtime bundle emitted warnings.");
}
if (!(await Bun.file(OUTPUT_ENTRY).exists())) {
  throw new Error(`npm runtime bundle did not emit ${relative(process.cwd(), OUTPUT_ENTRY)}.`);
}
if (!result.metafile) throw new Error("npm runtime bundle did not emit a metafile.");

await Bun.write(METAFILE, `${JSON.stringify(result.metafile, null, 2)}\n`);

const bundledInputs = Object.keys(result.metafile.inputs);
for (const required of [
  "src/cli/main.ts",
  "node_modules/@3akhp/opentui-core/",
  "node_modules/@3akhp/opentui-solid/",
  "node_modules/solid-js/",
]) {
  if (!bundledInputs.some((input) => input.replaceAll("\\", "/").includes(required))) {
    throw new Error(`npm runtime bundle is missing expected input: ${required}`);
  }
}
for (const forbidden of ["node_modules/@babel/", "node_modules/babel-plugin-module-resolver/", "node_modules/glob/"]) {
  if (bundledInputs.some((input) => input.replaceAll("\\", "/").includes(forbidden))) {
    throw new Error(`npm runtime bundle unexpectedly includes compiler input: ${forbidden}`);
  }
}

const output = await Bun.file(OUTPUT_ENTRY).text();
if (/react\/jsx-(?:dev-)?runtime/.test(output)) {
  throw new Error("npm runtime bundle contains a React JSX runtime import.");
}
if (/from\s*["'`]@3akhp\/opentui-solid["'`]|(?:import|require)\s*\(\s*["'`]@3akhp\/opentui-solid["'`]\s*\)/.test(output)) {
  throw new Error("npm runtime bundle still imports @3akhp/opentui-solid at runtime.");
}
if (/from\s*["'`]@3akhp\/opentui-core["'`]|(?:import|require)\s*\(\s*["'`]@3akhp\/opentui-core["'`]\s*\)/.test(output)) {
  throw new Error("npm runtime bundle still imports the @3akhp/opentui-core entry at runtime.");
}
if (/from\s*["'`]@3akhp\/opentui-core\/testing["'`]|(?:import|require)\s*\(\s*["'`]@3akhp\/opentui-core\/testing["'`]\s*\)/.test(output)) {
  throw new Error("npm runtime bundle still imports a second OpenTUI core through its testing subpath.");
}
// The fork loader's platform-variant imports stay external (see the externals
// list); every other upstream-scoped specifier in import position is a leak.
const upstreamImports = [...output.matchAll(/(?:from\s*|(?:import|require)\s*\(\s*)["'`](@opentui\/[^"'`]+)["'`]/g)]
  .map((match) => match[1]);
const leakedUpstream = [
  ...new Set(upstreamImports.filter((specifier) => !/^@opentui\/core-(?:darwin|linux|win32)-[a-z0-9-]+$/.test(specifier))),
];
if (leakedUpstream.length > 0) {
  throw new Error(`npm runtime bundle still imports upstream @opentui/* packages: ${leakedUpstream.join(", ")}`);
}
if (!output.includes("class MarkdownRenderable") || !output.includes("set selectionBg") || !output.includes("set selectionFg")) {
  throw new Error("npm runtime bundle is missing the fork-native Markdown selection implementation.");
}

console.error(`Built ${relative(process.cwd(), OUTPUT_ENTRY)} from ${bundledInputs.length} inputs.`);

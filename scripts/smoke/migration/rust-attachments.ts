import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve("target/debug", process.platform === "win32" ? "vesicle-rust-dev.exe" : "vesicle-rust-dev");
const sandbox = await mkdtemp(join(tmpdir(), "vesicle-attachment-guards-"));
const project = join(sandbox, "project");
const store = join(project, ".vesicle/attachments");
const session = join(project, "session.jsonl");
const results: string[] = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const image = (bytes: Uint8Array) => ({ id: "fixture", path: `.vesicle/attachments/${hash(bytes)}.png`, mediaType: "image/png", bytes: bytes.length, sha256: hash(bytes), source: "project" });

async function verify(images: unknown[], expectedError?: string) {
  await writeFile(session, JSON.stringify({ sessionId: "fixture", ts: "now", role: "user", content: "verify", metadata: { images } }));
  const inputBefore = await readFile(session);
  const output = Bun.spawnSync([binary, "verify-attachments", project, session], { timeout: 20_000 });
  assert.deepEqual(await readFile(session), inputBefore, "verification must not rewrite its input");
  if (expectedError) {
    assert.equal(output.exitCode, 1, output.stderr.toString());
    assert.equal(output.stdout.length, 0);
    assert.equal(JSON.parse(output.stderr.toString()).error, expectedError);
    return;
  }
  assert.equal(output.exitCode, 0, output.stderr.toString());
  assert.equal(output.stderr.length, 0);
  const report = JSON.parse(output.stdout.toString());
  assert.equal(report.attachmentsVerified, true);
  return report;
}

try {
  await mkdir(store, { recursive: true });
  const bytes = await readFile("tests/fixtures/migration/corpus/attachment/project/.vesicle/attachments/637f66e34e99be0b59ed7f800503edc085a03ac8d65b7ca30a7187d3d7ce0f42.png");
  const reference = image(bytes);
  const path = join(project, reference.path);
  await writeFile(path, bytes);
  assert.deepEqual((await verify([reference, reference])).attachmentVerification, { references: 2, files: 1, bytes: bytes.length });
  assert.deepEqual((await verify([])).attachmentVerification, { references: 0, files: 0, bytes: 0 });
  results.push("reference-dedup-and-empty-store");
  for (const unsafe of ["../outside.png", "/outside.png", ".vesicle/attachments/../outside.png", ".vesicle\\attachments\\file.png"]) {
    await verify([{ ...reference, path: unsafe }], "attachment.unsafe_path");
  }
  await verify([{ ...reference, bytes: reference.bytes + 1 }], "attachment.size_mismatch");
  await verify([{ ...reference, bytes: 20 * 1024 * 1024 + 1 }], "attachment.size_limit");
  await verify([{ ...reference, data: "inline" }], "attachment.inline_data_unsupported");
  await verify(Array.from({ length: 1025 }, () => reference), "attachment.reference_limit");
  results.push("unsafe-metadata-and-reference-limits");

  const changed = Buffer.from(bytes); changed[changed.length - 1]! ^= 1;
  await writeFile(path, changed);
  await verify([reference], "attachment.hash_mismatch");
  await writeFile(path, bytes);
  const jpeg = { ...reference, path: reference.path.replace(/\.png$/, ".jpg"), mediaType: "image/jpeg" };
  await writeFile(join(project, jpeg.path), bytes);
  await verify([jpeg], "attachment.media_mismatch");
  results.push("same-size-corruption-and-media-mismatch");

  // Exercise the real aggregate I/O bound: five verified 20 MiB files fill the
  // budget; the sixth is rejected before any read (its file does not exist).
  const large = Buffer.alloc(20 * 1024 * 1024); large.set(bytes.subarray(0, 8));
  const batch = [];
  for (let index = 0; index < 6; index++) {
    large[8] = index;
    const entry = image(large); batch.push(entry);
    if (index < 5) await writeFile(join(project, entry.path), large);
  }
  await verify(batch, "attachment.total_limit");
  results.push("aggregate-read-budget");

  const outside = join(sandbox, "outside"); await mkdir(outside);
  const externalImage = join(outside, `${reference.sha256}.png`); await writeFile(externalImage, bytes);
  if (process.platform !== "win32") {
    await rm(path); await symlink(externalImage, path);
    await verify([reference], "attachment.unsafe_path");
    await rm(path); await writeFile(path, bytes);
    results.push("unix-file-symlink-rejection");
  }
  await rm(store, { recursive: true });
  await symlink(outside, store, process.platform === "win32" ? "junction" : "dir");
  await verify([reference], "attachment.unsafe_path");
  assert.deepEqual(await readFile(externalImage), bytes, "redirect target must be unchanged");
  results.push(process.platform === "win32" ? "native-windows-junction-rejection" : "directory-symlink-rejection");
  console.log(JSON.stringify({ schemaVersion: 1, platform: process.platform, passed: results, skipped: process.platform === "win32" ? ["file-symlink creation requires privileges; native directory junction exercised"] : [] }, null, 2));
} finally { await rm(sandbox, { recursive: true, force: true }); }

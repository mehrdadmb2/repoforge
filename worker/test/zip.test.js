import test from "node:test";
import assert from "node:assert/strict";
import "../../assets/zip.js";
import { safeBranch, safePath, safeRepoName } from "../src/utils.js";

const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}
function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}
function concat(parts) {
  const length = parts.reduce((sum, item) => sum + item.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const item of parts) { result.set(item, offset); offset += item.length; }
  return result;
}

async function makeZip(entries, method = 0) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [path, text] of Object.entries(entries)) {
    const name = encoder.encode(path);
    const content = encoder.encode(text);
    const checksum = crc32(content);
    let compressed = content;
    if (method === 8) {
      const stream = new Blob([content]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const local = concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressed.length), u32(content.length),
      u16(name.length), u16(0), name, compressed
    ]);
    localParts.push(local);
    const central = concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(0), u16(0),
      u32(checksum), u32(compressed.length), u32(content.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
    ]);
    centralParts.push(central);
    offset += local.length;
  }
  const central = concat(centralParts);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(centralParts.length), u16(centralParts.length),
    u32(central.length), u32(offset), u16(0)
  ]);
  return concat([...localParts, central, end]);
}

const makeFile = (bytes, name = "release.zip") => Object.assign(new Blob([bytes]), { name });
async function extract(entries, options = {}) {
  const archive = await makeZip(entries, options.compressionMethod || 0);
  return globalThis.RepoForgeZip.extract(makeFile(archive), options);
}

test("browser ZIP reader extracts stored entries and returns base64 payloads", async () => {
  const result = await extract({
    "project-main/README.md": "RepoForge test",
    "project-main/src/index.js": "export const ok = true;"
  });
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["README.md", "src/index.js"]);
  const readme = result.files.find((file) => file.path === "README.md");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(readme.base64), (c) => c.charCodeAt(0))), "RepoForge test");
});


test("browser ZIP reader decompresses DEFLATE entries", async () => {
  const result = await extract({ "src/app.js": "export const answer = 42;" }, { compressionMethod: 8, stripRoot: false });
  const file = result.files[0];
  assert.equal(file.path, "src/app.js");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))), "export const answer = 42;");
});

test("rejects an invalid ZIP CRC checksum", async () => {
  const archive = await makeZip({ "file.txt": "valid content" });
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let central = -1;
  for (let offset = 0; offset <= archive.length - 4; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) { central = offset; break; }
  }
  assert.notEqual(central, -1);
  view.setUint32(central + 16, 0, true);
  await assert.rejects(() => globalThis.RepoForgeZip.extract(makeFile(archive)), /CRC checksum mismatch/);
});

test("does not strip a common folder when entries are already at archive root", async () => {
  const result = await extract({ "README.md": "readme", "src/app.js": "app" });
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["README.md", "src/app.js"]);
});

test("rejects path traversal ZIP entries", async () => {
  await assert.rejects(() => extract({ "../outside.txt": "nope" }), /Unsafe ZIP path/);
});

test("rejects .git metadata entries", async () => {
  await assert.rejects(() => extract({ ".git/config": "nope" }), /\.git directory/);
});

test("rejects a file path that collides with a directory path", async () => {
  await assert.rejects(() => extract({ "config": "file", "config/settings.json": "nested" }), /File\/directory path collision/);
});

test("enforces expanded archive and individual file limits", async () => {
  await assert.rejects(() => extract({ "large.txt": "0123456789" }, { limits: { maxExpandedBytes: 5 } }), /Expanded archive exceeds/);
  await assert.rejects(() => extract({ "large.txt": "0123456789" }, { limits: { maxFileBytes: 5 } }), /per-file limit/);
});

test("validates repository, branch and path inputs", () => {
  assert.equal(safeRepoName("mehrdadmb2/repoforge"), "mehrdadmb2/repoforge");
  assert.throws(() => safeRepoName("https://github.com/foo/bar"), /owner\/repository/);
  assert.equal(safeBranch("feature/release-v2"), "feature/release-v2");
  assert.throws(() => safeBranch("../main"), /Invalid branch/);
  assert.equal(safePath("assets/app.js"), "assets/app.js");
  assert.throws(() => safePath("../secrets.txt"), /Unsafe repository path/);
});

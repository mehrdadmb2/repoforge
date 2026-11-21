import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { inspectZip, stripCommonRoot } from "../src/zip.js";

const encoder = new TextEncoder();

test("inspects a valid ZIP and returns file metadata and bytes", () => {
  const archive = zipSync({
    "project-main/README.md": encoder.encode("RepoForge test"),
    "project-main/src/index.js": encoder.encode("export const ok = true;")
  });
  const files = inspectZip(archive);
  assert.equal(files.length, 2);
  assert.equal(files.find((file) => file.path.endsWith("README.md")).size, 14);
  assert.equal(new TextDecoder().decode(files.find((file) => file.path.endsWith("index.js")).bytes), "export const ok = true;");
});

test("strips only one shared top-level directory", () => {
  const archive = zipSync({
    "project-main/README.md": encoder.encode("readme"),
    "project-main/src/app.js": encoder.encode("app")
  });
  const files = stripCommonRoot(inspectZip(archive), true);
  assert.deepEqual(files.map((file) => file.path).sort(), ["README.md", "src/app.js"]);
});

test("does not strip a directory when paths are at the archive root", () => {
  const archive = zipSync({
    "README.md": encoder.encode("readme"),
    "src/app.js": encoder.encode("app")
  });
  const files = stripCommonRoot(inspectZip(archive), true);
  assert.deepEqual(files.map((file) => file.path).sort(), ["README.md", "src/app.js"]);
});

test("rejects path traversal entries", () => {
  const archive = zipSync({ "../outside.txt": encoder.encode("nope") });
  assert.throws(() => inspectZip(archive), /Path traversal/);
});

test("rejects files above the configured expanded-size limit", () => {
  const archive = zipSync({ "large.txt": encoder.encode("0123456789") });
  assert.throws(() => inspectZip(archive, { maxExpandedBytes: 5 }), /Expanded ZIP size/);
});

test("rejects paths inside the Git metadata directory", () => {
  const archive = zipSync({ ".git/config": encoder.encode("not allowed") });
  assert.throws(() => inspectZip(archive), /\.git directory/);
});

test("rejects overlong ZIP paths", () => {
  const archive = zipSync({ [`${"a".repeat(1025)}.txt`]: encoder.encode("x") });
  assert.throws(() => inspectZip(archive), /1024-character/);
});

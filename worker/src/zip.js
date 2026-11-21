import { unzipSync } from "fflate";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function u16(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function u32(bytes, offset) { return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0; }

function normalizeZipPath(path) {
  if (!path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) {
    throw new Error(`Unsafe ZIP path: ${JSON.stringify(path)}`);
  }
  if (path.length > 1024) throw new Error("ZIP path exceeds the 1024-character safety limit.");
  const segments = path.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`Path traversal is not allowed: ${path}`);
  }
  if (segments.some((segment) => segment.length > 255)) throw new Error("A ZIP path segment exceeds the 255-character safety limit.");
  if (segments.some((segment) => /[\x00-\x1f]/.test(segment))) {
    throw new Error(`Control characters are not allowed in paths: ${path}`);
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) throw new Error("The .git directory must never be deployed.");
  return segments.filter(Boolean).join("/");
}

function readCentralDirectory(bytes, limits) {
  const min = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This is not a valid ZIP archive (end record missing).");
  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const diskEntries = u16(bytes, eocd + 8);
  const entryCount = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error("Multi-disk ZIP archives are not supported.");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported by this deployment profile.");
  if (entryCount > limits.maxFiles + 100) throw new Error(`Archive contains too many entries. Maximum is ${limits.maxFiles} files.`);
  if (centralOffset + centralSize > eocd) throw new Error("ZIP central directory is invalid.");

  const entries = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  const seen = new Set();

  for (let index = 0; index < entryCount; index++) {
    if (u32(bytes, cursor) !== 0x02014b50) throw new Error("ZIP central directory entry is corrupted.");
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const externalAttributes = u32(bytes, cursor + 38);
    const nameStart = cursor + 46;
    if (cursor + 46 + nameLength + extraLength + commentLength > centralOffset + centralSize) throw new Error("ZIP entry exceeds central directory bounds.");
    if (flags & 0x0001) throw new Error("Encrypted ZIP files are not supported.");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}.`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error("ZIP64 entries are not supported.");

    let rawName;
    try {
      const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
      rawName = (flags & 0x0800) ? textDecoder.decode(nameBytes) : new TextDecoder("windows-1252").decode(nameBytes);
    } catch {
      throw new Error("A ZIP filename is not valid text.");
    }
    const isDirectory = rawName.endsWith("/");
    const path = normalizeZipPath(isDirectory ? rawName.slice(0, -1) : rawName);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0xf000;
    if (fileType === 0xa000) throw new Error(`Symbolic links are not allowed: ${path}`);
    if (!isDirectory && path) {
      if (seen.has(path)) throw new Error(`Duplicate file path in ZIP: ${path}`);
      seen.add(path);
      if (uncompressedSize > limits.maxFileBytes) throw new Error(`File exceeds the per-file limit (${limits.maxFileBytes} bytes): ${path}`);
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > limits.maxExpandedBytes) throw new Error(`Expanded ZIP size exceeds ${limits.maxExpandedBytes} bytes.`);
      entries.push({ path, compressedSize, size: uncompressedSize, method });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length > limits.maxFiles) throw new Error(`Archive contains ${entries.length} files; maximum is ${limits.maxFiles}.`);
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size does not match its entries.");
  return entries;
}

export function inspectZip(bytes, options = {}) {
  const limits = {
    maxFiles: Number(options.maxFiles || 400),
    maxFileBytes: Number(options.maxFileBytes || 8 * 1024 * 1024),
    maxExpandedBytes: Number(options.maxExpandedBytes || 32 * 1024 * 1024)
  };
  const metadata = readCentralDirectory(bytes, limits);
  let extracted;
  try { extracted = unzipSync(bytes); }
  catch (error) { throw new Error(`Unable to extract ZIP archive: ${error.message}`); }

  const files = [];
  for (const item of metadata) {
    const content = extracted[item.path];
    if (!(content instanceof Uint8Array)) throw new Error(`ZIP entry could not be extracted: ${item.path}`);
    if (content.byteLength !== item.size) throw new Error(`ZIP size mismatch for ${item.path}.`);
    files.push({ path: item.path, size: content.byteLength, compressedSize: item.compressedSize, bytes: content });
  }
  return files;
}

export function stripCommonRoot(files, enabled = true) {
  if (!enabled || !files.length) return files;
  const firstSegments = files.map((file) => file.path.split("/")[0]);
  const common = firstSegments[0];
  if (!common || !firstSegments.every((segment) => segment === common) || files.some((file) => !file.path.includes("/"))) return files;
  const stripped = files.map((file) => ({ ...file, path: file.path.slice(common.length + 1) }));
  if (stripped.some((file) => !file.path || file.path.startsWith("../") || file.path.includes("/../"))) return files;
  return stripped;
}

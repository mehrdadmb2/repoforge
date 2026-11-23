/*
 * RepoForge browser-side ZIP reader.
 * ZIP parsing and decompression run in the admin's browser, not inside the
 * 10 ms CPU-limited Cloudflare Workers Free runtime.
 * Supported: single-disk, non-encrypted ZIP, stored (0) and DEFLATE (8).
 * ZIP64 and symbolic links are deliberately rejected.
 */
(() => {
  'use strict';

  const DEFAULTS = Object.freeze({
    maxArchiveBytes: 19 * 1024 * 1024,
    maxExpandedBytes: 16 * 1024 * 1024,
    maxFileBytes: 1 * 1024 * 1024,
    maxFiles: 400
  });

  const u16 = (view, offset) => view.getUint16(offset, true);
  const u32 = (view, offset) => view.getUint32(offset, true);

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function normalizePath(input) {
    if (!input || input.startsWith('/') || input.includes('\\') || input.includes('\0') || /^[a-z]:/i.test(input)) {
      throw new Error(`Unsafe ZIP path: ${JSON.stringify(input)}`);
    }
    if (input.length > 1024) throw new Error('A ZIP path exceeds 1024 characters.');
    const segments = input.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.length > 255)) {
      throw new Error(`Unsafe ZIP path: ${input}`);
    }
    if (segments.some((segment) => segment.toLowerCase() === '.git')) {
      throw new Error('The .git directory is not allowed in a deployment archive.');
    }
    if (segments.some((segment) => /[\x00-\x1f\x7f]/.test(segment))) {
      throw new Error(`Control characters are not allowed in ZIP paths: ${input}`);
    }
    return segments.join('/');
  }

  function locateEndRecord(bytes, view) {
    const min = Math.max(0, bytes.length - 65557);
    for (let offset = bytes.length - 22; offset >= min; offset--) {
      if (offset >= 0 && u32(view, offset) === 0x06054b50) {
        const commentLength = u16(view, offset + 20);
        if (offset + 22 + commentLength <= bytes.length) return offset;
      }
    }
    throw new Error('The ZIP end-of-central-directory record was not found.');
  }

  async function inflateRaw(compressed) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser does not support native ZIP decompression. Please use an up-to-date Chrome or Edge browser.');
    }
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      throw new Error(`Unable to decompress a ZIP entry: ${error.message || error}`);
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }

  function stripCommonRoot(files, enabled) {
    if (!enabled || files.length === 0) return files;
    const first = files[0].path.split('/')[0];
    if (!first || files.some((file) => file.path.split('/')[0] !== first || !file.path.includes('/'))) return files;
    return files.map((file) => ({ ...file, path: file.path.slice(first.length + 1) }));
  }

  async function extract(file, options = {}, onProgress = () => {}) {
    const limits = { ...DEFAULTS, ...(options.limits || {}) };
    if (!(file instanceof Blob)) throw new Error('Choose a ZIP file first.');
    if (file.size < 22 || file.size > limits.maxArchiveBytes) {
      throw new Error(`ZIP size must be between 22 bytes and ${(limits.maxArchiveBytes / 1048576).toFixed(0)} MB.`);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = locateEndRecord(bytes, view);
    const diskNumber = u16(view, eocd + 4);
    const centralDisk = u16(view, eocd + 6);
    const diskEntries = u16(view, eocd + 8);
    const totalEntries = u16(view, eocd + 10);
    const centralSize = u32(view, eocd + 12);
    const centralOffset = u32(view, eocd + 16);

    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      throw new Error('Multi-disk ZIP archives are not supported.');
    }
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported by this Free-plan deployment profile.');
    }
    if (totalEntries > limits.maxFiles + 100) throw new Error(`Archive contains too many entries; maximum is ${limits.maxFiles} files.`);
    if (centralOffset + centralSize > eocd) throw new Error('ZIP central directory is outside the archive.');

    const decoderUtf8 = new TextDecoder('utf-8', { fatal: true });
    const decoderLegacy = new TextDecoder('windows-1252');
    const metadata = [];
    const seen = new Set();
    const parentPaths = new Set();
    let cursor = centralOffset;
    let expandedTotal = 0;

    for (let i = 0; i < totalEntries; i++) {
      if (cursor + 46 > centralOffset + centralSize || u32(view, cursor) !== 0x02014b50) {
        throw new Error('ZIP central directory is corrupted.');
      }
      const flags = u16(view, cursor + 8);
      const method = u16(view, cursor + 10);
      const expectedCrc = u32(view, cursor + 16);
      const compressedSize = u32(view, cursor + 20);
      const uncompressedSize = u32(view, cursor + 24);
      const nameLength = u16(view, cursor + 28);
      const extraLength = u16(view, cursor + 30);
      const commentLength = u16(view, cursor + 32);
      const externalAttributes = u32(view, cursor + 38);
      const localOffset = u32(view, cursor + 42);
      const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
      if (recordEnd > centralOffset + centralSize) throw new Error('A ZIP central directory entry exceeds its bounds.');
      if (flags & 0x0001) throw new Error('Encrypted ZIP archives are not supported.');
      if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}.`);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('ZIP64 entries are not supported.');
      }

      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      let rawName;
      try { rawName = (flags & 0x0800) ? decoderUtf8.decode(nameBytes) : decoderLegacy.decode(nameBytes); }
      catch { throw new Error('A ZIP filename is not valid UTF-8.'); }
      const isDirectory = rawName.endsWith('/');
      if (!isDirectory) {
        const path = normalizePath(rawName);
        const unixMode = (externalAttributes >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) throw new Error(`Symbolic links are not allowed: ${path}`);
        if (seen.has(path)) throw new Error(`Duplicate path in ZIP: ${path}`);
        if (parentPaths.has(path)) throw new Error(`File/directory path collision in ZIP: ${path}`);
        const segments = path.split('/');
        for (let depth = 1; depth < segments.length; depth++) {
          const parent = segments.slice(0, depth).join('/');
          if (seen.has(parent)) throw new Error(`File/directory path collision in ZIP: ${parent}`);
          parentPaths.add(parent);
        }
        seen.add(path);
        if (uncompressedSize > limits.maxFileBytes) throw new Error(`File exceeds the ${Math.round(limits.maxFileBytes / 1048576)} MB per-file limit: ${path}`);
        expandedTotal += uncompressedSize;
        if (expandedTotal > limits.maxExpandedBytes) throw new Error(`Expanded archive exceeds ${(limits.maxExpandedBytes / 1048576).toFixed(0)} MB.`);
        metadata.push({ path, method, expectedCrc, compressedSize, uncompressedSize, localOffset });
      }
      cursor = recordEnd;
    }

    if (cursor !== centralOffset + centralSize) throw new Error('ZIP central directory size does not match its entries.');
    if (metadata.length === 0) throw new Error('The ZIP archive does not contain any files.');
    if (metadata.length > limits.maxFiles) throw new Error(`Archive contains ${metadata.length} files; maximum is ${limits.maxFiles}.`);

    const files = [];
    for (let index = 0; index < metadata.length; index++) {
      const entry = metadata[index];
      const offset = entry.localOffset;
      if (offset + 30 > bytes.length || u32(view, offset) !== 0x04034b50) {
        throw new Error(`Local ZIP header is corrupted: ${entry.path}`);
      }
      const localNameLength = u16(view, offset + 26);
      const localExtraLength = u16(view, offset + 28);
      const dataStart = offset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > bytes.length) throw new Error(`ZIP data is truncated: ${entry.path}`);
      const compressed = bytes.subarray(dataStart, dataEnd);
      const content = entry.method === 0 ? new Uint8Array(compressed) : await inflateRaw(compressed);
      if (content.byteLength !== entry.uncompressedSize) throw new Error(`ZIP size mismatch: ${entry.path}`);
      if (crc32(content) !== entry.expectedCrc) throw new Error(`ZIP CRC checksum mismatch: ${entry.path}`);
      files.push({ path: entry.path, size: content.byteLength, base64: bytesToBase64(content) });
      onProgress({ current: index + 1, total: metadata.length, path: entry.path, bytes: expandedTotal });
    }

    return {
      fileName: file.name || 'release.zip',
      archiveBytes: file.size,
      expandedBytes: expandedTotal,
      files: stripCommonRoot(files, options.stripRoot !== false)
    };
  }

  globalThis.RepoForgeZip = Object.freeze({ extract, defaults: DEFAULTS });
})();

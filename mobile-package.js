(function initShadowingPackage(globalScope) {
  "use strict";

  const FORMAT = "japanese-shadowing-mobile-project";
  const SUPPORTED_VERSION = 1;
  const EOCD_SIGNATURE = 0x06054b50;
  const ZIP64_EOCD_SIGNATURE = 0x06064b50;
  const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  const textEncoder = new TextEncoder();

  class PackageError extends Error {
    constructor(message, code = "invalid_package") {
      super(message);
      this.name = "PackageError";
      this.code = code;
    }
  }

  function readUint64(view, offset) {
    if (typeof view.getBigUint64 === "function") {
      const value = view.getBigUint64(offset, true);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new PackageError("项目包过大，当前浏览器无法安全读取");
      }
      return Number(value);
    }
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    const value = high * 0x100000000 + low;
    if (!Number.isSafeInteger(value)) throw new PackageError("项目包过大，当前浏览器无法安全读取");
    return value;
  }

  function safeEntryPath(path) {
    return Boolean(path)
      && !path.startsWith("/")
      && !path.startsWith("\\")
      && !path.includes("\\")
      && path.split("/").every((part) => part && part !== "." && part !== "..");
  }

  async function dataView(blob) {
    return new DataView(await blob.arrayBuffer());
  }

  async function findCentralDirectory(file) {
    if (!file || !Number.isFinite(file.size) || file.size < 22) {
      throw new PackageError("项目包为空或不完整");
    }
    const tailSize = Math.min(file.size, 22 + 65535 + 20);
    const tailOffset = file.size - tailSize;
    const tail = await dataView(file.slice(tailOffset));
    let eocdIndex = -1;
    for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
      if (tail.getUint32(index, true) === EOCD_SIGNATURE) {
        const commentLength = tail.getUint16(index + 20, true);
        if (index + 22 + commentLength === tail.byteLength) {
          eocdIndex = index;
          break;
        }
      }
    }
    if (eocdIndex < 0) throw new PackageError("无法读取项目包目录，文件可能不完整");
    if (tail.getUint16(eocdIndex + 4, true) !== 0 || tail.getUint16(eocdIndex + 6, true) !== 0) {
      throw new PackageError("不支持分卷 ZIP 项目包");
    }

    let entryCount = tail.getUint16(eocdIndex + 10, true);
    let directorySize = tail.getUint32(eocdIndex + 12, true);
    let directoryOffset = tail.getUint32(eocdIndex + 16, true);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const absoluteEocd = tailOffset + eocdIndex;
      if (absoluteEocd < 20) throw new PackageError("ZIP64 项目包目录不完整");
      const locator = await dataView(file.slice(absoluteEocd - 20, absoluteEocd));
      if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) {
        throw new PackageError("ZIP64 项目包缺少目录定位信息");
      }
      const zip64Offset = readUint64(locator, 8);
      const zip64 = await dataView(file.slice(zip64Offset, zip64Offset + 56));
      if (zip64.byteLength < 56 || zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
        throw new PackageError("ZIP64 项目包目录损坏");
      }
      entryCount = readUint64(zip64, 32);
      directorySize = readUint64(zip64, 40);
      directoryOffset = readUint64(zip64, 48);
    }
    if (entryCount < 1 || entryCount > 1000) throw new PackageError("项目包文件数量异常");
    if (directoryOffset + directorySize > file.size) throw new PackageError("项目包目录超出文件范围");
    return { entryCount, directoryOffset, directorySize };
  }

  function applyZip64Extra(entry, extra) {
    let offset = 0;
    while (offset + 4 <= extra.byteLength) {
      const id = extra.getUint16(offset, true);
      const size = extra.getUint16(offset + 2, true);
      const start = offset + 4;
      const end = start + size;
      if (end > extra.byteLength) throw new PackageError("ZIP 扩展字段损坏");
      if (id === 0x0001) {
        let cursor = start;
        if (entry.uncompressedSize === 0xffffffff) {
          entry.uncompressedSize = readUint64(extra, cursor);
          cursor += 8;
        }
        if (entry.compressedSize === 0xffffffff) {
          entry.compressedSize = readUint64(extra, cursor);
          cursor += 8;
        }
        if (entry.localHeaderOffset === 0xffffffff) {
          entry.localHeaderOffset = readUint64(extra, cursor);
        }
        break;
      }
      offset = end;
    }
  }

  async function readEntries(file) {
    const directory = await findCentralDirectory(file);
    const buffer = await file.slice(
      directory.directoryOffset,
      directory.directoryOffset + directory.directorySize,
    ).arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const entries = new Map();
    let offset = 0;
    for (let count = 0; count < directory.entryCount; count += 1) {
      if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
        throw new PackageError("项目包文件目录损坏");
      }
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > view.byteLength) throw new PackageError("项目包文件目录被截断");
      if (flags & 0x0001) throw new PackageError("不支持加密的项目包");
      let name;
      try {
        name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      } catch (_error) {
        throw new PackageError("项目包包含无法识别的文件名");
      }
      if (!safeEntryPath(name)) throw new PackageError("项目包包含不安全的文件路径");
      if (entries.has(name)) throw new PackageError("项目包包含重复文件");
      const entry = {
        name,
        flags,
        method,
        compressedSize: view.getUint32(offset + 20, true),
        uncompressedSize: view.getUint32(offset + 24, true),
        localHeaderOffset: view.getUint32(offset + 42, true),
      };
      const extra = new DataView(buffer, offset + 46 + nameLength, extraLength);
      applyZip64Extra(entry, extra);
      if (entry.method !== 0) throw new PackageError("项目包使用了手机端不支持的压缩方式");
      if (entry.compressedSize !== entry.uncompressedSize) throw new PackageError("项目包文件大小异常");
      entries.set(name, entry);
      offset = end;
    }
    return entries;
  }

  async function entryBlob(file, entry, type = "application/octet-stream") {
    const header = await dataView(file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30));
    if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new PackageError(`无法读取 ${entry.name}`);
    }
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (start < 0 || end > file.size) throw new PackageError(`${entry.name} 超出项目包范围`);
    return file.slice(start, end, type);
  }

  function hex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  class Sha256 {
    constructor() {
      this.state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
      ]);
      this.buffer = new Uint8Array(64);
      this.bufferLength = 0;
      this.bytesHashed = 0;
      this.finished = false;
      this.words = new Uint32Array(64);
    }

    update(data) {
      if (this.finished) throw new Error("SHA-256 已结束");
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      this.bytesHashed += bytes.length;
      let position = 0;
      while (position < bytes.length) {
        const take = Math.min(bytes.length - position, 64 - this.bufferLength);
        this.buffer.set(bytes.subarray(position, position + take), this.bufferLength);
        this.bufferLength += take;
        position += take;
        if (this.bufferLength === 64) {
          this._compress(this.buffer);
          this.bufferLength = 0;
        }
      }
      return this;
    }

    digest() {
      if (!this.finished) {
        const bitLength = this.bytesHashed * 8;
        this.buffer[this.bufferLength++] = 0x80;
        if (this.bufferLength > 56) {
          this.buffer.fill(0, this.bufferLength);
          this._compress(this.buffer);
          this.bufferLength = 0;
        }
        this.buffer.fill(0, this.bufferLength, 56);
        const high = Math.floor(bitLength / 0x100000000);
        const low = bitLength >>> 0;
        const view = new DataView(this.buffer.buffer);
        view.setUint32(56, high, false);
        view.setUint32(60, low, false);
        this._compress(this.buffer);
        this.finished = true;
      }
      const output = new Uint8Array(32);
      const view = new DataView(output.buffer);
      this.state.forEach((word, index) => view.setUint32(index * 4, word, false));
      return output;
    }

    _compress(chunk) {
      const words = this.words;
      const view = new DataView(chunk.buffer, chunk.byteOffset, 64);
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
      for (let index = 16; index < 64; index += 1) {
        const w15 = words[index - 15];
        const w2 = words[index - 2];
        const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = this.state;
      for (let index = 0; index < 64; index += 1) {
        const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0;
        const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (s0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      this.state[0] = (this.state[0] + a) >>> 0;
      this.state[1] = (this.state[1] + b) >>> 0;
      this.state[2] = (this.state[2] + c) >>> 0;
      this.state[3] = (this.state[3] + d) >>> 0;
      this.state[4] = (this.state[4] + e) >>> 0;
      this.state[5] = (this.state[5] + f) >>> 0;
      this.state[6] = (this.state[6] + g) >>> 0;
      this.state[7] = (this.state[7] + h) >>> 0;
    }
  }

  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  async function sha256Blob(blob, onProgress) {
    const hasher = new Sha256();
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const chunk = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
      hasher.update(chunk);
      if (onProgress) onProgress(Math.min(blob.size, offset + chunk.length), blob.size);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return hex(hasher.digest());
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[index] = value >>> 0;
    }
    return table;
  })();

  async function crc32Blob(blob) {
    let crc = 0xffffffff;
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const bytes = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + chunkSize)).arrayBuffer());
      for (let index = 0; index < bytes.length; index += 1) {
        crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    };
  }

  async function createStoredZip(inputEntries) {
    if (!Array.isArray(inputEntries) || !inputEntries.length || inputEntries.length > 65535) {
      throw new PackageError("导出文件数量异常");
    }
    const entries = [];
    let localOffset = 0;
    for (const input of inputEntries) {
      const name = String(input?.name || "");
      if (!safeEntryPath(name)) throw new PackageError("导出包包含不安全的文件路径");
      const blob = input.data instanceof Blob
        ? input.data
        : new Blob([input.data], { type: input.type || "application/octet-stream" });
      const nameBytes = textEncoder.encode(name);
      if (nameBytes.length > 65535 || blob.size > 0xffffffff) throw new PackageError("单个录音过大，无法导出");
      const crc = await crc32Blob(blob);
      const stamp = dosDateTime(input.modifiedAt ? new Date(input.modifiedAt) : new Date());
      const localHeader = new ArrayBuffer(30);
      const local = new DataView(localHeader);
      local.setUint32(0, LOCAL_SIGNATURE, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, stamp.time, true);
      local.setUint16(12, stamp.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, blob.size, true);
      local.setUint32(22, blob.size, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      entries.push({ nameBytes, blob, crc, stamp, localHeader, localOffset });
      localOffset += 30 + nameBytes.length + blob.size;
      if (localOffset > 0xffffffff) throw new PackageError("录音包过大，无法导出");
    }

    const parts = [];
    entries.forEach((entry) => parts.push(entry.localHeader, entry.nameBytes, entry.blob));
    const directoryOffset = localOffset;
    entries.forEach((entry) => {
      const header = new ArrayBuffer(46);
      const view = new DataView(header);
      view.setUint32(0, CENTRAL_SIGNATURE, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0x0800, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, entry.stamp.time, true);
      view.setUint16(14, entry.stamp.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.blob.size, true);
      view.setUint32(24, entry.blob.size, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, entry.localOffset, true);
      parts.push(header, entry.nameBytes);
      localOffset += 46 + entry.nameBytes.length;
    });
    const directorySize = localOffset - directoryOffset;
    const eocd = new ArrayBuffer(22);
    const eocdView = new DataView(eocd);
    eocdView.setUint32(0, EOCD_SIGNATURE, true);
    eocdView.setUint16(8, entries.length, true);
    eocdView.setUint16(10, entries.length, true);
    eocdView.setUint32(12, directorySize, true);
    eocdView.setUint32(16, directoryOffset, true);
    parts.push(eocd);
    return new Blob(parts, { type: "application/zip" });
  }

  function requireString(value, message) {
    if (typeof value !== "string" || !value.trim()) throw new PackageError(message);
    return value.trim();
  }

  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== "object") throw new PackageError("manifest.json 内容无效");
    if (manifest.format !== FORMAT) throw new PackageError("这不是手机跟读项目包");
    if (manifest.version !== SUPPORTED_VERSION) {
      throw new PackageError(`暂不支持项目包版本 ${String(manifest.version)}`, "unsupported_version");
    }
    if (!manifest.series || typeof manifest.series !== "object") throw new PackageError("项目包缺少番剧信息");
    requireString(manifest.series.key, "项目包缺少番剧标识");
    requireString(manifest.series.title, "项目包缺少番剧名称");
    if (!Array.isArray(manifest.episodes) || !manifest.episodes.length || manifest.episodes.length > 200) {
      throw new PackageError("项目包集数异常");
    }
  }

  async function parseJsonBlob(blob, label) {
    try {
      return JSON.parse(await blob.text());
    } catch (_error) {
      throw new PackageError(`${label} 不是有效 JSON`);
    }
  }

  async function inspect(file, onProgress = () => {}) {
    onProgress(1, "正在读取项目包目录");
    const entries = await readEntries(file);
    const manifestEntry = entries.get("manifest.json");
    if (!manifestEntry) throw new PackageError("项目包缺少 manifest.json");
    const manifest = await parseJsonBlob(await entryBlob(file, manifestEntry, "application/json"), "manifest.json");
    validateManifest(manifest);

    const totalBytes = manifest.episodes.reduce((sum, episode) => sum
      + Number(episode?.video?.size || 0)
      + Number(episode?.transcript?.size || 0), 0);
    let checkedBytes = 0;
    const episodes = [];
    const projectIds = new Set();
    for (let index = 0; index < manifest.episodes.length; index += 1) {
      const episode = manifest.episodes[index];
      const projectId = requireString(episode?.project_id, "项目包包含无编号的剧集");
      if (projectIds.has(projectId)) throw new PackageError("项目包包含重复剧集");
      projectIds.add(projectId);
      const videoPath = requireString(episode?.video?.path, `${projectId} 缺少视频路径`);
      const transcriptPath = requireString(episode?.transcript?.path, `${projectId} 缺少字幕路径`);
      const videoEntry = entries.get(videoPath);
      const transcriptEntry = entries.get(transcriptPath);
      if (!videoEntry || !transcriptEntry) throw new PackageError(`${projectId} 的视频或字幕文件缺失`);
      if (videoEntry.uncompressedSize !== Number(episode.video.size)
        || transcriptEntry.uncompressedSize !== Number(episode.transcript.size)) {
        throw new PackageError(`${projectId} 的文件大小与清单不一致`);
      }

      onProgress(4 + (checkedBytes / Math.max(1, totalBytes)) * 88, `正在校验 ${episode.episode_label || `第 ${index + 1} 集`}`);
      const transcriptBlob = await entryBlob(file, transcriptEntry, "application/json");
      const transcriptHash = await sha256Blob(transcriptBlob);
      if (transcriptHash !== String(episode.transcript.sha256 || "").toLowerCase()) {
        throw new PackageError(`${episode.episode_label || projectId} 的字幕校验失败`);
      }
      checkedBytes += transcriptBlob.size;
      const transcript = await parseJsonBlob(transcriptBlob, `${episode.episode_label || projectId} 字幕`);
      if (transcript.format !== FORMAT || transcript.version !== SUPPORTED_VERSION || transcript.project_id !== projectId) {
        throw new PackageError(`${episode.episode_label || projectId} 的字幕格式不匹配`);
      }
      const videoBlob = await entryBlob(file, videoEntry, "video/mp4");
      const videoStart = checkedBytes;
      const videoHash = await sha256Blob(videoBlob, (done) => {
        onProgress(4 + ((videoStart + done) / Math.max(1, totalBytes)) * 88, `正在校验 ${episode.episode_label || `第 ${index + 1} 集`}`);
      });
      if (videoHash !== String(episode.video.sha256 || "").toLowerCase()) {
        throw new PackageError(`${episode.episode_label || projectId} 的视频校验失败`);
      }
      checkedBytes += videoBlob.size;
      episodes.push({ manifest: episode, transcript, videoBlob });
    }
    onProgress(94, "项目包校验完成");
    return { manifest, episodes, storedBytes: totalBytes };
  }

  const api = {
    FORMAT,
    SUPPORTED_VERSION,
    PackageError,
    Sha256,
    createStoredZip,
    inspect,
    readEntries,
    entryBlob,
    sha256Blob,
    safeEntryPath,
    validateManifest,
  };
  globalScope.ShadowingPackage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof globalThis !== "undefined" ? globalThis : this));

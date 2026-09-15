(function initMobileLibrary() {
  "use strict";

  const DB_NAME = "tokyo-shadowing-mobile";
  const DB_VERSION = 2;
  const SERIES_STORE = "series";
  const EPISODE_STORE = "episodes";
  const RECORDING_STORE = "recordings";
  const VIDEO_DIRECTORY = "videos";
  const RECORDING_DIRECTORY = "recordings";
  const elements = {
    packageInput: document.querySelector("#packageInput"),
    installButton: document.querySelector("#installButton"),
    projectSummary: document.querySelector("#projectSummary"),
    storageUsage: document.querySelector("#storageUsage"),
    importStatus: document.querySelector("#importStatus"),
    importStatusTitle: document.querySelector("#importStatusTitle"),
    importStatusMessage: document.querySelector("#importStatusMessage"),
    importProgressText: document.querySelector("#importProgressText"),
    importProgressBar: document.querySelector("#importProgressBar"),
    importProgress: document.querySelector(".progress-track"),
    library: document.querySelector("#library"),
    emptyState: document.querySelector("#emptyState"),
    toast: document.querySelector("#toast"),
    confirmDialog: document.querySelector("#confirmDialog"),
    confirmTitle: document.querySelector("#confirmTitle"),
    confirmMessage: document.querySelector("#confirmMessage"),
  };
  let databasePromise;
  let installPrompt;
  let toastTimer;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("本地数据库操作失败"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("本地数据库操作失败"));
      transaction.onabort = () => reject(transaction.error || new Error("本地数据库操作已取消"));
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(SERIES_STORE)) {
          database.createObjectStore(SERIES_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(EPISODE_STORE)) {
          const store = database.createObjectStore(EPISODE_STORE, { keyPath: "storageKey" });
          store.createIndex("seriesKey", "seriesKey", { unique: false });
        }
        if (!database.objectStoreNames.contains(RECORDING_STORE)) {
          const store = database.createObjectStore(RECORDING_STORE, { keyPath: "storageKey" });
          store.createIndex("seriesKey", "seriesKey", { unique: false });
          store.createIndex("episodeStorageKey", "episodeStorageKey", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开手机本地存储"));
      request.onblocked = () => reject(new Error("本地数据库正在被另一个页面使用"));
    });
    return databasePromise;
  }

  async function allRecords(storeName) {
    const database = await openDatabase();
    const transaction = database.transaction(storeName, "readonly");
    return requestResult(transaction.objectStore(storeName).getAll());
  }

  async function episodesForSeries(seriesKey) {
    const database = await openDatabase();
    const transaction = database.transaction(EPISODE_STORE, "readonly");
    return requestResult(transaction.objectStore(EPISODE_STORE).index("seriesKey").getAll(seriesKey));
  }

  async function recordingsForSeries(seriesKey) {
    const database = await openDatabase();
    const transaction = database.transaction(RECORDING_STORE, "readonly");
    return requestResult(transaction.objectStore(RECORDING_STORE).index("seriesKey").getAll(seriesKey));
  }

  async function recordingsForEpisode(episodeStorageKey) {
    const database = await openDatabase();
    const transaction = database.transaction(RECORDING_STORE, "readonly");
    return requestResult(transaction.objectStore(RECORDING_STORE).index("episodeStorageKey").getAll(episodeStorageKey));
  }

  function episodeStorageKey(seriesKey, projectId) {
    return `${seriesKey}\u001f${projectId}`;
  }

  function supportsPersistentFiles() {
    return typeof navigator.storage?.getDirectory === "function";
  }

  function videoFileName(manifest) {
    const projectId = String(manifest.project_id || "episode")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 80);
    return `${String(manifest.video.sha256).toLowerCase()}-${projectId}.mp4`;
  }

  async function videoDirectory(create = false) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(VIDEO_DIRECTORY, { create });
  }

  async function recordingDirectory(create = false) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(RECORDING_DIRECTORY, { create });
  }

  async function storeVideoFile(blob, fileName, onProgress = () => {}) {
    const directory = await videoDirectory(true);
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    const chunkSize = 4 * 1024 * 1024;
    try {
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const end = Math.min(blob.size, offset + chunkSize);
        await writable.write(blob.slice(offset, end));
        onProgress(end, blob.size);
      }
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }
  }

  async function removeVideoFile(fileName) {
    if (!fileName || !supportsPersistentFiles()) return;
    try {
      const directory = await videoDirectory(false);
      await directory.removeEntry(fileName);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
  }

  async function removeRecordingFile(fileName) {
    if (!fileName || !supportsPersistentFiles()) return;
    try {
      const directory = await recordingDirectory(false);
      await directory.removeEntry(fileName);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
  }

  async function recordingBlob(recording) {
    if (recording.fileName) {
      const directory = await recordingDirectory(false);
      const handle = await directory.getFileHandle(recording.fileName);
      return handle.getFile();
    }
    if (recording.blob instanceof Blob) return recording.blob;
    throw new Error(`${recording.episodeLabel || "某一集"}有一条录音文件不存在`);
  }

  async function hasVideoFile(fileName, expectedSize) {
    if (!fileName || !supportsPersistentFiles()) return false;
    try {
      const directory = await videoDirectory(false);
      const handle = await directory.getFileHandle(fileName);
      const file = await handle.getFile();
      return file.size > 0 && (!expectedSize || file.size === Number(expectedSize));
    } catch (error) {
      if (error?.name === "NotFoundError") return false;
      throw error;
    }
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let amount = bytes;
    let unit = -1;
    do {
      amount /= 1024;
      unit += 1;
    } while (amount >= 1024 && unit < units.length - 1);
    return `${amount >= 100 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[unit]}`;
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Math.round(Number(value) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${minutes}:${String(rest).padStart(2, "0")}`;
  }

  function episodeSort(left, right) {
    const leftNumber = Number(left.episodeNumber);
    const rightNumber = Number(right.episodeNumber);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return String(left.episodeLabel).localeCompare(String(right.episodeLabel), "zh-CN");
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3200);
  }

  function updateImportProgress(progress, message, title = "正在检查项目包") {
    const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
    elements.importStatus.hidden = false;
    elements.importStatusTitle.textContent = title;
    elements.importStatusMessage.textContent = message;
    elements.importProgressText.textContent = `${Math.round(safeProgress)}%`;
    elements.importProgressBar.style.width = `${safeProgress}%`;
    elements.importProgress.setAttribute("aria-valuenow", String(Math.round(safeProgress)));
  }

  async function confirmAction(title, message) {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmDialog.returnValue = "cancel";
    elements.confirmDialog.showModal();
    return new Promise((resolve) => {
      elements.confirmDialog.addEventListener("close", () => {
        resolve(elements.confirmDialog.returnValue === "confirm");
      }, { once: true });
    });
  }

  async function checkAvailableStorage(requiredBytes) {
    if (!navigator.storage?.estimate) return;
    const estimate = await navigator.storage.estimate();
    if (!Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return;
    const free = Math.max(0, estimate.quota - estimate.usage);
    const reserve = Math.max(32 * 1024 * 1024, estimate.quota * 0.03);
    if (requiredBytes + reserve > free) {
      throw new ShadowingPackage.PackageError(
        `手机可用空间不足：需要约 ${formatBytes(requiredBytes)}，当前可用约 ${formatBytes(free)}`,
        "insufficient_storage",
      );
    }
  }

  async function saveInspectedPackage(result, file) {
    const seriesKey = String(result.manifest.series.key);
    const existingEpisodes = await episodesForSeries(seriesKey);
    const existingByProject = new Map(existingEpisodes.map((episode) => [episode.projectId, episode]));
    const persistentFileStatus = new Map();
    if (supportsPersistentFiles()) {
      await Promise.all(existingEpisodes.map(async (episode) => {
        persistentFileStatus.set(
          episode.projectId,
          await hasVideoFile(episode.videoFileName, episode.videoSize),
        );
      }));
    }
    let skipped = 0;
    let replaced = 0;
    const imports = [];
    result.episodes.forEach(({ manifest, transcript, videoBlob }) => {
      const previous = existingByProject.get(manifest.project_id);
      const previousVideoReady = previous && persistentFileStatus.get(previous.projectId) === true;
      const needsStorageMigration = previous && supportsPersistentFiles() && !previousVideoReady;
      if (previous?.videoSha256 === manifest.video.sha256
        && previous?.transcriptSha256 === manifest.transcript.sha256
        && !needsStorageMigration) {
        skipped += 1;
        return;
      }
      if (previous) replaced += 1;
      imports.push({ manifest, transcript, videoBlob, previous, previousVideoReady });
    });
    if (!imports.length) {
      throw new ShadowingPackage.PackageError("这个项目包的全部剧集已经导入", "duplicate_package");
    }

    const bytesToWrite = imports.reduce((sum, episode) => sum + episode.videoBlob.size
      + Number(episode.manifest.transcript.size || 0), 0);
    await checkAvailableStorage(bytesToWrite);
    if (navigator.storage?.persist) await navigator.storage.persist().catch(() => false);
    const storedEpisodes = [];
    const newlyWrittenFiles = [];
    let writtenBytes = 0;
    const totalVideoBytes = imports.reduce((sum, episode) => sum + episode.videoBlob.size, 0);
    try {
      for (const episode of imports) {
        const {
          manifest, videoBlob, previous, previousVideoReady,
        } = episode;
        let storedVideoFileName = "";
        if (supportsPersistentFiles()) {
          if (previousVideoReady && previous.videoSha256 === manifest.video.sha256) {
            storedVideoFileName = previous.videoFileName;
            writtenBytes += videoBlob.size;
          } else {
            storedVideoFileName = videoFileName(manifest);
            await storeVideoFile(videoBlob, storedVideoFileName, (current) => {
              const progress = 95 + ((writtenBytes + current) / Math.max(1, totalVideoBytes)) * 4;
              updateImportProgress(progress, "正在保存视频到手机", "正在导入项目");
            });
            newlyWrittenFiles.push(storedVideoFileName);
            writtenBytes += videoBlob.size;
          }
        }
        storedEpisodes.push({ ...episode, storedVideoFileName });
      }
    } catch (error) {
      await Promise.all(newlyWrittenFiles.map((fileName) => removeVideoFile(fileName).catch(() => {})));
      throw error;
    }
    updateImportProgress(99, "正在保存字幕和项目索引", "正在导入项目");
    const database = await openDatabase();
    const transaction = database.transaction([SERIES_STORE, EPISODE_STORE], "readwrite");
    const seriesStore = transaction.objectStore(SERIES_STORE);
    const episodeStore = transaction.objectStore(EPISODE_STORE);
    const now = new Date().toISOString();
    seriesStore.put({
      key: seriesKey,
      title: String(result.manifest.series.title),
      createdAt: result.manifest.created_at || now,
      importedAt: now,
      formatVersion: result.manifest.version,
    });
    storedEpisodes.forEach(({ manifest, transcript, videoBlob, storedVideoFileName }) => {
      const episodeRecord = {
        storageKey: episodeStorageKey(seriesKey, manifest.project_id),
        seriesKey,
        projectId: String(manifest.project_id),
        episodeNumber: manifest.episode_number,
        episodeLabel: String(manifest.episode_label || `第 ${manifest.episode_number || "?"} 集`),
        duration: Number(manifest.duration || transcript.duration || 0),
        quality: String(result.manifest.quality || ""),
        videoSize: videoBlob.size,
        videoSha256: String(manifest.video.sha256),
        transcriptSha256: String(manifest.transcript.sha256),
        transcript,
        videoStorage: storedVideoFileName ? "opfs" : "indexeddb",
        videoFileName: storedVideoFileName,
        importedAt: now,
        sourceFile: file.name,
      };
      if (!storedVideoFileName) episodeRecord.videoBlob = videoBlob;
      episodeStore.put(episodeRecord);
    });
    try {
      await transactionDone(transaction);
    } catch (error) {
      await Promise.all(newlyWrittenFiles.map((fileName) => removeVideoFile(fileName).catch(() => {})));
      throw error;
    }
    const obsoleteFiles = storedEpisodes
      .filter(({ previous, storedVideoFileName }) => previous?.videoFileName
        && previous.videoFileName !== storedVideoFileName)
      .map(({ previous }) => previous.videoFileName);
    await Promise.all(obsoleteFiles.map((fileName) => removeVideoFile(fileName).catch(() => {})));
    return { imported: imports.length, skipped, replaced };
  }

  async function importPackage(file) {
    if (!file) return;
    if (!String(file.name).toLowerCase().endsWith(".shadowing")) {
      showToast("请选择 .shadowing 项目包");
      return;
    }
    elements.packageInput.disabled = true;
    updateImportProgress(0, "读取项目清单");
    try {
      const inspected = await ShadowingPackage.inspect(file, updateImportProgress);
      const summary = await saveInspectedPackage(inspected, file);
      updateImportProgress(100, `已保存 ${summary.imported} 集`, "导入完成");
      await renderLibrary();
      const extras = [];
      if (summary.replaced) extras.push(`更新 ${summary.replaced} 集`);
      if (summary.skipped) extras.push(`跳过 ${summary.skipped} 集重复内容`);
      showToast(`已导入 ${summary.imported} 集${extras.length ? `，${extras.join("，")}` : ""}`);
      window.setTimeout(() => { elements.importStatus.hidden = true; }, 2200);
    } catch (error) {
      updateImportProgress(0, error.message || "无法导入项目包", "导入失败");
      showToast(error.message || "无法导入项目包");
    } finally {
      elements.packageInput.disabled = false;
      elements.packageInput.value = "";
    }
  }

  function safeFilePart(value, fallback) {
    const cleaned = String(value || "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ");
    return (cleaned || fallback).slice(0, 80);
  }

  function recordingFileExtension(recording) {
    const existing = String(recording.fileName || "").match(/\.([a-zA-Z0-9]{2,5})$/)?.[1];
    if (existing) return existing.toLowerCase();
    const mimeType = String(recording.mimeType || "").toLowerCase();
    if (mimeType.includes("mp4") || mimeType.includes("aac") || mimeType.includes("m4a")) return "m4a";
    if (mimeType.includes("ogg")) return "ogg";
    return "webm";
  }

  async function deliverRecordingPackage(series, packageBlob) {
    const fileName = `${safeFilePart(series.title, "手机跟读录音")}.shadowing-recordings`;
    const file = new File([packageBlob], fileName, { type: "application/zip" });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `${series.title} 手机跟读录音` });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function exportSeriesRecordings(series, recordings) {
    if (!recordings.length) {
      showToast("这部番剧还没有手机录音");
      return;
    }
    updateImportProgress(2, `准备 ${recordings.length} 条录音`, "正在导出手机录音");
    const files = [];
    const manifestRecordings = [];
    for (let index = 0; index < recordings.length; index += 1) {
      const recording = recordings[index];
      const blob = await recordingBlob(recording);
      const extension = recordingFileExtension(recording);
      const path = `recordings/${safeFilePart(recording.projectId, "episode")}/${safeFilePart(recording.segmentId, String(index))}.${extension}`;
      updateImportProgress(5 + (index / recordings.length) * 70, `校验 ${recording.episodeLabel || "录音"}`, "正在导出手机录音");
      const sha256 = await ShadowingPackage.sha256Blob(blob);
      files.push({ name: path, data: blob, modifiedAt: recording.savedAt });
      manifestRecordings.push({
        project_id: String(recording.projectId),
        episode_number: recording.episodeNumber,
        episode_label: String(recording.episodeLabel || ""),
        segment_id: Number(recording.segmentId),
        segment_start: Number(recording.segmentStart || 0),
        japanese_text: String(recording.japaneseText || ""),
        chinese_text: String(recording.chineseText || ""),
        path,
        mime_type: String(blob.type || recording.mimeType || "application/octet-stream"),
        size: blob.size,
        sha256,
        saved_at: recording.savedAt || new Date().toISOString(),
      });
    }
    const manifest = {
      format: "japanese-shadowing-mobile-recordings",
      version: 1,
      created_at: new Date().toISOString(),
      series: { key: String(series.key), title: String(series.title) },
      recordings: manifestRecordings,
    };
    files.unshift({
      name: "manifest.json",
      data: new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
    });
    updateImportProgress(78, "正在生成录音包", "正在导出手机录音");
    const packageBlob = await ShadowingPackage.createStoredZip(files);
    updateImportProgress(100, `${recordings.length} 条录音已打包`, "导出完成");
    await deliverRecordingPackage(series, packageBlob);
    showToast(`已导出 ${recordings.length} 条录音`);
    window.setTimeout(() => { elements.importStatus.hidden = true; }, 2200);
  }

  async function deleteEpisode(series, episode) {
    const confirmed = await confirmAction("删除这一集？", `${episode.episodeLabel} 的视频、字幕、录音、笔记和进度将从手机删除。`);
    if (!confirmed) return;
    const recordings = await recordingsForEpisode(episode.storageKey);
    const database = await openDatabase();
    const transaction = database.transaction([SERIES_STORE, EPISODE_STORE, RECORDING_STORE], "readwrite");
    transaction.objectStore(EPISODE_STORE).delete(episode.storageKey);
    recordings.forEach((recording) => transaction.objectStore(RECORDING_STORE).delete(recording.storageKey));
    const remainingRequest = transaction.objectStore(EPISODE_STORE).index("seriesKey").count(series.key);
    remainingRequest.onsuccess = () => {
      if (remainingRequest.result === 0) transaction.objectStore(SERIES_STORE).delete(series.key);
    };
    await transactionDone(transaction);
    await removeVideoFile(episode.videoFileName).catch(() => {});
    await Promise.all(recordings.map((recording) => removeRecordingFile(recording.fileName).catch(() => {})));
    await renderLibrary();
    showToast("这一集已删除");
  }

  async function deleteSeries(series, episodeCount) {
    const confirmed = await confirmAction("删除整部番剧？", `${series.title} 的 ${episodeCount} 集视频、字幕和录音将全部删除。`);
    if (!confirmed) return;
    const [episodes, recordings] = await Promise.all([episodesForSeries(series.key), recordingsForSeries(series.key)]);
    const database = await openDatabase();
    const transaction = database.transaction([SERIES_STORE, EPISODE_STORE, RECORDING_STORE], "readwrite");
    const episodeStore = transaction.objectStore(EPISODE_STORE);
    episodes.forEach((episode) => episodeStore.delete(episode.storageKey));
    recordings.forEach((recording) => transaction.objectStore(RECORDING_STORE).delete(recording.storageKey));
    transaction.objectStore(SERIES_STORE).delete(series.key);
    await transactionDone(transaction);
    await Promise.all(episodes.map((episode) => removeVideoFile(episode.videoFileName).catch(() => {})));
    await Promise.all(recordings.map((recording) => removeRecordingFile(recording.fileName).catch(() => {})));
    await renderLibrary();
    showToast("番剧项目已删除");
  }

  function renderEpisode(series, episode, recordings = []) {
    const row = document.createElement("div");
    row.className = "mobile-episode-row";
    const info = document.createElement("div");
    info.className = "mobile-episode-info";
    const title = document.createElement("strong");
    title.textContent = episode.episodeLabel;
    const meta = document.createElement("span");
    const recordingText = recordings.length ? ` · ${recordings.length} 条录音` : "";
    meta.textContent = `${formatDuration(episode.duration)} · ${episode.quality || "手机画质"} · ${formatBytes(episode.videoSize)}${recordingText}`;
    info.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "mobile-episode-actions";
    const open = document.createElement("a");
    open.className = "button-primary";
    open.textContent = "打开";
    open.href = `./mobile-player.html?series=${encodeURIComponent(series.key)}&episode=${encodeURIComponent(episode.projectId)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button-quiet-danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => deleteEpisode(series, episode));
    actions.append(open, remove);
    row.append(info, actions);
    return row;
  }

  async function renderLibrary() {
    const [seriesRecords, episodeRecords, recordingRecords] = await Promise.all([
      allRecords(SERIES_STORE),
      allRecords(EPISODE_STORE),
      allRecords(RECORDING_STORE),
    ]);
    const episodesBySeries = new Map();
    episodeRecords.forEach((episode) => {
      if (!episodesBySeries.has(episode.seriesKey)) episodesBySeries.set(episode.seriesKey, []);
      episodesBySeries.get(episode.seriesKey).push(episode);
    });
    const recordingsBySeries = new Map();
    const recordingsByEpisode = new Map();
    recordingRecords.forEach((recording) => {
      if (!recordingsBySeries.has(recording.seriesKey)) recordingsBySeries.set(recording.seriesKey, []);
      recordingsBySeries.get(recording.seriesKey).push(recording);
      if (!recordingsByEpisode.has(recording.episodeStorageKey)) recordingsByEpisode.set(recording.episodeStorageKey, []);
      recordingsByEpisode.get(recording.episodeStorageKey).push(recording);
    });
    elements.library.replaceChildren();
    seriesRecords.sort((left, right) => String(right.importedAt).localeCompare(String(left.importedAt)));
    seriesRecords.forEach((series) => {
      const episodes = (episodesBySeries.get(series.key) || []).sort(episodeSort);
      const recordings = recordingsBySeries.get(series.key) || [];
      if (!episodes.length) return;
      const details = document.createElement("details");
      details.className = "mobile-series";
      details.open = seriesRecords.length === 1;
      const summary = document.createElement("summary");
      const titleBlock = document.createElement("span");
      titleBlock.className = "mobile-series-title";
      const title = document.createElement("strong");
      title.textContent = series.title;
      const totalBytes = episodes.reduce((sum, episode) => sum + Number(episode.videoSize || 0), 0)
        + recordings.reduce((sum, recording) => sum + Number(recording.size || 0), 0);
      const qualities = [...new Set(episodes.map((episode) => episode.quality).filter(Boolean))];
      const meta = document.createElement("span");
      const recordingText = recordings.length ? ` · ${recordings.length} 条录音` : "";
      meta.textContent = `${episodes.length} 集 · ${qualities.join(" / ") || "手机画质"} · ${formatBytes(totalBytes)}${recordingText}`;
      titleBlock.append(title, meta);
      const chevron = document.createElement("span");
      chevron.className = "mobile-series-chevron";
      chevron.textContent = "⌄";
      chevron.setAttribute("aria-hidden", "true");
      summary.append(titleBlock, chevron);
      const body = document.createElement("div");
      body.className = "mobile-series-body";
      episodes.forEach((episode) => body.append(renderEpisode(series, episode, recordingsByEpisode.get(episode.storageKey) || [])));
      const footer = document.createElement("div");
      footer.className = "mobile-series-footer";
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "button-primary";
      exportButton.textContent = `导出录音${recordings.length ? ` (${recordings.length})` : ""}`;
      exportButton.disabled = recordings.length === 0;
      exportButton.addEventListener("click", () => {
        exportSeriesRecordings(series, recordings).catch((error) => {
          updateImportProgress(0, error.message || "无法导出录音", "导出失败");
          showToast(error.message || "无法导出录音");
        });
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button-quiet-danger";
      remove.textContent = "删除整部番剧";
      remove.addEventListener("click", () => deleteSeries(series, episodes.length));
      footer.append(exportButton, remove);
      details.append(summary, body, footer);
      elements.library.append(details);
    });
    const seriesCount = [...episodesBySeries.values()].filter((episodes) => episodes.length).length;
    const totalBytes = episodeRecords.reduce((sum, episode) => sum + Number(episode.videoSize || 0), 0)
      + recordingRecords.reduce((sum, recording) => sum + Number(recording.size || 0), 0);
    elements.projectSummary.textContent = `${seriesCount} 部 · ${episodeRecords.length} 集`;
    elements.storageUsage.textContent = formatBytes(totalBytes);
    elements.emptyState.hidden = episodeRecords.length > 0;
  }

  elements.packageInput.addEventListener("change", () => importPackage(elements.packageInput.files?.[0]));
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    elements.installButton.hidden = false;
  });
  elements.installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    elements.installButton.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    elements.installButton.hidden = true;
  });
  window.addEventListener("online", () => document.body.classList.remove("is-offline"));
  window.addEventListener("offline", () => document.body.classList.add("is-offline"));
  document.body.classList.toggle("is-offline", !navigator.onLine);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./mobile-sw.js").catch(() => {});
  }
  renderLibrary().catch((error) => showToast(error.message || "无法读取本地项目"));
}());

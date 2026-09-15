(function initMobilePlayer() {
  "use strict";

  const DB_NAME = "tokyo-shadowing-mobile";
  const DB_VERSION = 2;
  const SERIES_STORE = "series";
  const EPISODE_STORE = "episodes";
  const RECORDING_STORE = "recordings";
  const VIDEO_DIRECTORY = "videos";
  const RECORDING_DIRECTORY = "recordings";
  const AUTO_NEXT_KEY = "tokyo-shadowing:auto-next";
  const SPEED_KEY = "tokyo-shadowing:playback-speed";
  const CONTROLS_PINNED_KEY = "tokyo-shadowing:controls-pinned";
  const PANE_WIDTH_KEY = "tokyo-shadowing:landscape-video-width";
  const CONTROLS_HIDE_DELAY = 1100;
  const DEFAULT_PANE_WIDTH = 44;
  const MIN_PANE_WIDTH = 30;
  const MAX_PANE_WIDTH = 70;
  const elements = {
    playerLayout: document.querySelector("#playerLayout"),
    playerShell: document.querySelector("#playerShell"),
    video: document.querySelector("#video"),
    seriesTitle: document.querySelector("#seriesTitle"),
    episodeTitle: document.querySelector("#episodeTitle"),
    fullscreenButton: document.querySelector("#fullscreenButton"),
    playButton: document.querySelector("#playButton"),
    backButton: document.querySelector("#backButton"),
    forwardButton: document.querySelector("#forwardButton"),
    repeatButton: document.querySelector("#repeatButton"),
    speedControl: document.querySelector("#speedControl"),
    speedButton: document.querySelector("#speedButton"),
    speedMenu: document.querySelector("#speedMenu"),
    recordButton: document.querySelector("#recordButton"),
    recordingPanel: document.querySelector("#recordingPanel"),
    recordingStatus: document.querySelector("#recordingStatus"),
    recordingTime: document.querySelector("#recordingTime"),
    recordingMeter: document.querySelector("#recordingMeter"),
    recordingMeterLevel: document.querySelector("#recordingMeterLevel"),
    recordingPlayButton: document.querySelector("#recordingPlayButton"),
    recordingDeleteButton: document.querySelector("#recordingDeleteButton"),
    recordingAudio: document.querySelector("#recordingAudio"),
    playerControls: document.querySelector("#playerControls"),
    timeline: document.querySelector("#timeline"),
    currentTime: document.querySelector("#currentTime"),
    duration: document.querySelector("#duration"),
    controlsPinButton: document.querySelector("#controlsPinButton"),
    paneResizer: document.querySelector("#paneResizer"),
    overlayJapanese: document.querySelector("#overlayJapanese"),
    overlayChinese: document.querySelector("#overlayChinese"),
    transcriptList: document.querySelector("#transcriptList"),
    autoNext: document.querySelector("#autoNext"),
    playerError: document.querySelector("#playerError"),
    playerErrorMessage: document.querySelector("#playerErrorMessage"),
    toast: document.querySelector("#toast"),
  };
  let databasePromise;
  let episodeRecord;
  let seriesRecord;
  let seriesEpisodes = [];
  let segments = [];
  let activeIndex = -1;
  let repeatIndex = -1;
  let repeatEnabled = false;
  let overlayJapaneseFromEmbedded = false;
  let overlayChineseFromEmbedded = false;
  let videoUrl;
  let controlsTimer;
  let controlsReleaseTimer;
  let progressSaveTimer;
  let toastTimer;
  let seeking = false;
  let playbackIntent = false;
  let suppressNextPlayControls = false;
  let ignorePlayClick = false;
  let controlsInteracting = false;
  let controlsPinned = false;
  let playbackSpeed = 1;
  let paneWidth = DEFAULT_PANE_WIDTH;
  let resizingPanes = false;
  let episodeRecordings = new Map();
  let activeRecording = null;
  let recordingAudioUrl = "";
  let recordingTimer = null;
  let viewportSyncFrame = 0;

  function syncViewportHeight() {
    window.cancelAnimationFrame(viewportSyncFrame);
    viewportSyncFrame = window.requestAnimationFrame(() => {
      const height = window.visualViewport?.height || window.innerHeight;
      if (Number.isFinite(height) && height > 0) {
        document.body.style.setProperty("--app-height", `${Math.floor(height)}px`);
      }
    });
  }

  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);
  window.visualViewport?.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", () => {
    syncViewportHeight();
    window.setTimeout(syncViewportHeight, 250);
  });

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法读取手机本地项目"));
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
    });
    return databasePromise;
  }

  async function getRecord(storeName, key) {
    const database = await openDatabase();
    return requestResult(database.transaction(storeName, "readonly").objectStore(storeName).get(key));
  }

  async function getAllEpisodes(seriesKey) {
    const database = await openDatabase();
    const store = database.transaction(EPISODE_STORE, "readonly").objectStore(EPISODE_STORE);
    if (seriesKey) return requestResult(store.index("seriesKey").getAll(seriesKey));
    return requestResult(store.getAll());
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("无法保存手机录音"));
      transaction.onabort = () => reject(transaction.error || new Error("手机录音保存已取消"));
    });
  }

  async function getEpisodeRecordings(episodeStorageKey) {
    const database = await openDatabase();
    const store = database.transaction(RECORDING_STORE, "readonly").objectStore(RECORDING_STORE);
    return requestResult(store.index("episodeStorageKey").getAll(episodeStorageKey));
  }

  function storageKey(seriesKey, projectId) {
    return `${seriesKey}\u001f${projectId}`;
  }

  function segmentId(segment, index) {
    return String(segment?.id ?? index);
  }

  function recordingStorageKey(record, segment, index) {
    return `${record.storageKey}\u001f${segmentId(segment, index)}`;
  }

  function supportsPersistentFiles() {
    return typeof navigator.storage?.getDirectory === "function";
  }

  async function recordingDirectory(create = false) {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(RECORDING_DIRECTORY, { create });
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
    if (recording?.fileName) {
      const directory = await recordingDirectory(false);
      const handle = await directory.getFileHandle(recording.fileName);
      return handle.getFile();
    }
    if (recording?.blob instanceof Blob) return recording.blob;
    throw new Error("这条录音文件不存在");
  }

  async function storeRecordingBlob(blob, fileName) {
    const directory = await recordingDirectory(true);
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      await directory.removeEntry(fileName).catch(() => {});
      throw error;
    }
  }

  function recordingExtension(mimeType) {
    const value = String(mimeType || "").toLowerCase();
    if (value.includes("mp4") || value.includes("aac") || value.includes("m4a")) return "m4a";
    if (value.includes("ogg")) return "ogg";
    return "webm";
  }

  function preferredRecordingMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) return "";
    return [
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
    ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function formatRecordingTime(milliseconds) {
    const totalTenths = Math.max(0, Math.floor(Number(milliseconds || 0) / 100));
    const minutes = Math.floor(totalTenths / 600);
    const seconds = Math.floor((totalTenths % 600) / 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
  }

  function readSetting(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (_error) {
      return fallback;
    }
  }

  function writeSetting(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (_error) {
      // Playback remains usable when private storage is unavailable.
    }
  }

  function playbackKey(record) {
    return `tokyo-shadowing:progress:${record.seriesKey}:${record.projectId}`;
  }

  function readPlayback(record) {
    try {
      const value = JSON.parse(readSetting(playbackKey(record), "{}"));
      return value && typeof value === "object" ? value : {};
    } catch (_error) {
      return {};
    }
  }

  function savePlayback(completed = false) {
    if (!episodeRecord || !Number.isFinite(elements.video.currentTime)) return;
    writeSetting(playbackKey(episodeRecord), JSON.stringify({
      position: completed ? 0 : elements.video.currentTime,
      completed,
      updatedAt: new Date().toISOString(),
    }));
  }

  function schedulePlaybackSave() {
    window.clearTimeout(progressSaveTimer);
    progressSaveTimer = window.setTimeout(() => savePlayback(false), 1200);
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 2800);
  }

  function showError(message) {
    elements.playerLayout.hidden = true;
    elements.playerErrorMessage.textContent = message;
    elements.playerError.hidden = false;
  }

  function isStandaloneApp() {
    return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function missingEpisodeMessage() {
    if (isStandaloneApp()) {
      return "这个主屏幕 App 中没有这一集。iPhone 不会把 Safari 已导入的本地项目复制到主屏幕 App，请在这里重新导入 .shadowing 项目包。";
    }
    return "当前浏览器中没有这一集，请返回项目列表重新打开或导入 .shadowing 项目包。";
  }

  async function storedVideoBlob(record) {
    if (record.videoFileName) {
      if (typeof navigator.storage?.getDirectory !== "function") {
        throw new Error("当前浏览器无法读取手机本地视频文件");
      }
      try {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle(VIDEO_DIRECTORY);
        const handle = await directory.getFileHandle(record.videoFileName);
        const file = await handle.getFile();
        if (!file.size) throw new Error("本地视频文件为空，请重新导入 .shadowing 项目包");
        return file;
      } catch (error) {
        if (error?.name === "NotFoundError") {
          throw new Error("本地视频文件不存在，请重新导入 .shadowing 项目包");
        }
        throw error;
      }
    }
    if (record.videoBlob instanceof Blob && record.videoBlob.size) return record.videoBlob;
    throw new Error(missingEpisodeMessage());
  }

  function configureSubtitleOverlay(transcript) {
    if (transcript?.mobile_subtitles_burned_in === true) {
      overlayJapaneseFromEmbedded = false;
      overlayChineseFromEmbedded = false;
      return;
    }
    const processing = transcript?.subtitle_processing || {};
    const japaneseSources = Object.keys(processing.japanese_sources || {});
    overlayJapaneseFromEmbedded = String(transcript?.japanese_text_source || "").startsWith("embedded_")
      || japaneseSources.some((source) => source.startsWith("embedded_"));
    overlayChineseFromEmbedded = transcript?.chinese_subtitle_source === "embedded"
      || processing.chinese_source === "embedded";
  }

  function formatTime(value, milliseconds = false) {
    const total = Math.max(0, Number(value) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = Math.floor(total % 60);
    const base = hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
    return milliseconds ? `${base}.${String(Math.floor((total % 1) * 1000)).padStart(3, "0")}` : base;
  }

  function japaneseText(segment) {
    return String(segment?.text || segment?.japanese || segment?.japanese_text || "").trim();
  }

  function chineseText(segment) {
    return String(segment?.chinese_text || segment?.chinese || segment?.translation || "").trim();
  }

  function appendAnnotatedText(container, segment) {
    const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
    if (!tokens.length) {
      container.textContent = japaneseText(segment);
      return;
    }
    tokens.forEach((token) => {
      const surface = String(token.surface || "");
      const reading = String(token.reading || "");
      const hasKanji = /[\u3400-\u9fff々〆ヵヶ]/u.test(surface);
      if (!token.is_punctuation && hasKanji && reading && reading !== surface) {
        const ruby = document.createElement("ruby");
        ruby.append(document.createTextNode(surface));
        const rt = document.createElement("rt");
        rt.textContent = reading;
        ruby.append(rt);
        container.append(ruby);
      } else {
        container.append(document.createTextNode(surface));
      }
    });
    if (!container.textContent.trim()) container.textContent = japaneseText(segment);
  }

  function normalizedSegments(transcript) {
    const raw = Array.isArray(transcript?.segments) ? transcript.segments : [];
    return raw.filter((segment) => Number.isFinite(Number(segment?.start))
      && Number.isFinite(Number(segment?.end))
      && Number(segment.end) > Number(segment.start)
      && (japaneseText(segment) || chineseText(segment)))
      .map((segment) => ({ ...segment, start: Number(segment.start), end: Number(segment.end) }))
      .sort((left, right) => left.start - right.start || left.end - right.end);
  }

  function findActiveIndex(time) {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (time < segment.start) high = middle - 1;
      else if (time >= segment.end) low = middle + 1;
      else return middle;
    }
    return -1;
  }

  function nearestSegmentIndex(time) {
    const active = findActiveIndex(time);
    if (active >= 0) return active;
    const next = segments.findIndex((segment) => segment.start >= time);
    return next >= 0 ? next : segments.length - 1;
  }

  function setActiveSegment(index, scroll = true) {
    if (index === activeIndex) return;
    const previous = elements.transcriptList.querySelector(".transcript-row.is-active");
    previous?.classList.remove("is-active");
    activeIndex = index;
    if (index < 0 || !segments[index]) {
      elements.overlayJapanese.textContent = "";
      elements.overlayChinese.textContent = "";
      renderRecordingState();
      return;
    }
    const segment = segments[index];
    elements.overlayJapanese.textContent = overlayJapaneseFromEmbedded ? japaneseText(segment) : "";
    elements.overlayChinese.textContent = overlayChineseFromEmbedded ? chineseText(segment) : "";
    const row = elements.transcriptList.querySelector(`[data-index="${index}"]`);
    row?.classList.add("is-active");
    if (scroll && row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    renderRecordingState();
  }

  function seekToSegment(index, autoplay = false) {
    if (activeRecording) {
      showToast("请先停止当前录音");
      return;
    }
    const segment = segments[index];
    if (!segment) return;
    elements.video.currentTime = segment.start;
    setActiveSegment(index, true);
    if (repeatEnabled) repeatIndex = index;
    if (autoplay) {
      hideControls();
      setPlayback(true, false);
    }
  }

  function renderTranscript() {
    const fragment = document.createDocumentFragment();
    segments.forEach((segment, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "transcript-row";
      row.dataset.index = String(index);
      const time = document.createElement("time");
      time.textContent = formatTime(segment.start);
      const copy = document.createElement("span");
      copy.className = "transcript-row-copy";
      const japanese = document.createElement("strong");
      appendAnnotatedText(japanese, segment);
      const chinese = document.createElement("span");
      chinese.textContent = chineseText(segment);
      copy.append(japanese, chinese);
      const recordingMark = document.createElement("span");
      recordingMark.className = "transcript-recording-mark";
      recordingMark.textContent = "●";
      recordingMark.setAttribute("aria-label", "已有录音");
      row.append(time, copy, recordingMark);
      row.addEventListener("click", () => seekToSegment(index, true));
      fragment.append(row);
    });
    elements.transcriptList.replaceChildren(fragment);
    syncRecordingMarks();
  }

  function recordingForIndex(index) {
    const segment = segments[index];
    if (!episodeRecord || !segment) return null;
    return episodeRecordings.get(recordingStorageKey(episodeRecord, segment, index)) || null;
  }

  function syncRecordingMarks() {
    elements.transcriptList.querySelectorAll(".transcript-row").forEach((row) => {
      row.classList.toggle("has-recording", Boolean(recordingForIndex(Number(row.dataset.index))));
    });
  }

  function clearRecordingAudio() {
    elements.recordingAudio.pause();
    elements.recordingAudio.removeAttribute("src");
    elements.recordingAudio.load();
    if (recordingAudioUrl) URL.revokeObjectURL(recordingAudioUrl);
    recordingAudioUrl = "";
    elements.recordingPlayButton.textContent = "▶";
    elements.recordingPlayButton.setAttribute("aria-label", "播放这条录音");
  }

  function renderRecordingState() {
    const hasSegment = activeIndex >= 0 && Boolean(segments[activeIndex]);
    elements.recordButton.disabled = !hasSegment || !window.MediaRecorder || !navigator.mediaDevices?.getUserMedia;
    if (activeRecording) {
      elements.recordingPanel.hidden = false;
      elements.recordButton.setAttribute("aria-pressed", "true");
      elements.recordButton.setAttribute("aria-label", "停止录音");
      elements.recordButton.title = "停止录音";
      elements.recordingStatus.textContent = "正在录音";
      elements.recordingMeter.hidden = false;
      elements.recordingPlayButton.hidden = true;
      elements.recordingDeleteButton.hidden = true;
      return;
    }
    elements.recordButton.setAttribute("aria-pressed", "false");
    elements.recordButton.setAttribute("aria-label", "为当前字幕录音");
    elements.recordButton.title = "录音";
    const saved = hasSegment ? recordingForIndex(activeIndex) : null;
    elements.recordingPanel.hidden = !saved;
    elements.recordingMeter.hidden = true;
    elements.recordingMeterLevel.style.width = "0%";
    elements.recordingStatus.textContent = saved ? "已保存本机" : "尚无录音";
    elements.recordingTime.textContent = saved ? formatRecordingTime(Number(saved.duration || 0) * 1000) : "00:00.0";
    elements.recordingPlayButton.hidden = !saved;
    elements.recordingDeleteButton.hidden = !saved;
    clearRecordingAudio();
  }

  function stopRecordingMeter(recording) {
    window.clearInterval(recordingTimer);
    recordingTimer = null;
    if (recording?.meterFrame) window.cancelAnimationFrame(recording.meterFrame);
    recording?.audioContext?.close().catch(() => {});
    elements.recordingMeter.hidden = true;
    elements.recordingMeterLevel.style.width = "0%";
  }

  function startRecordingMeter(recording) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      recording.audioContext = new AudioContextClass();
      recording.audioSource = recording.audioContext.createMediaStreamSource(recording.stream);
      recording.analyser = recording.audioContext.createAnalyser();
      recording.analyser.fftSize = 256;
      recording.analyser.smoothingTimeConstant = 0.72;
      recording.audioSource.connect(recording.analyser);
      recording.meterSamples = new Uint8Array(recording.analyser.fftSize);
      recording.audioContext.resume().catch(() => {});
      const update = () => {
        if (activeRecording !== recording || recording.recorder.state === "inactive") return;
        recording.analyser.getByteTimeDomainData(recording.meterSamples);
        let sum = 0;
        recording.meterSamples.forEach((sample) => { sum += ((sample - 128) / 128) ** 2; });
        const level = Math.min(100, Math.max(2, Math.sqrt(sum / recording.meterSamples.length) * 280));
        elements.recordingMeterLevel.style.width = `${level}%`;
        recording.meterFrame = window.requestAnimationFrame(update);
      };
      update();
    } catch (_error) {
      // Timer and recording remain available when the level meter is unsupported.
    }
  }

  async function saveRecording(recording, blob) {
    if (!blob.size) throw new Error("没有录到声音，请重新录音");
    const previous = episodeRecordings.get(recording.storageKey);
    const safeProject = String(recording.projectId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 72);
    const safeSegment = String(recording.segmentId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
    const extension = recordingExtension(blob.type || recording.mimeType);
    const fileName = `${safeProject}-${safeSegment}-${Date.now()}.${extension}`;
    const value = {
      storageKey: recording.storageKey,
      seriesKey: recording.seriesKey,
      episodeStorageKey: recording.episodeStorageKey,
      projectId: recording.projectId,
      episodeNumber: recording.episodeNumber,
      episodeLabel: recording.episodeLabel,
      segmentId: recording.segmentId,
      segmentStart: recording.segmentStart,
      japaneseText: recording.japaneseText,
      chineseText: recording.chineseText,
      fileName: "",
      mimeType: blob.type || recording.mimeType || "application/octet-stream",
      size: blob.size,
      duration: Math.max(0.1, (performance.now() - recording.startedAt) / 1000),
      savedAt: new Date().toISOString(),
    };
    if (supportsPersistentFiles()) {
      await storeRecordingBlob(blob, fileName);
      value.fileName = fileName;
    } else {
      value.blob = blob;
    }
    try {
      const database = await openDatabase();
      const transaction = database.transaction(RECORDING_STORE, "readwrite");
      transaction.objectStore(RECORDING_STORE).put(value);
      await transactionDone(transaction);
    } catch (error) {
      await removeRecordingFile(value.fileName).catch(() => {});
      throw error;
    }
    if (previous?.fileName && previous.fileName !== value.fileName) {
      await removeRecordingFile(previous.fileName).catch(() => {});
    }
    episodeRecordings.set(value.storageKey, value);
    syncRecordingMarks();
  }

  async function finishRecording(recording, blob) {
    stopRecordingMeter(recording);
    recording.stream.getTracks().forEach((track) => track.stop());
    elements.recordingStatus.textContent = "正在保存";
    try {
      await saveRecording(recording, blob);
      showToast("录音已保存在本机");
    } catch (error) {
      showToast(error.message || "录音保存失败");
    } finally {
      if (activeRecording === recording) activeRecording = null;
      renderRecordingState();
      showControls();
    }
  }

  function stopCurrentRecording() {
    const recording = activeRecording;
    if (!recording || recording.recorder.state === "inactive") return;
    recording.recorder.stop();
  }

  async function startRecording() {
    if (activeRecording) {
      stopCurrentRecording();
      return;
    }
    let index = activeIndex;
    if (index < 0) index = nearestSegmentIndex(elements.video.currentTime);
    const segment = segments[index];
    if (!segment || !episodeRecord) {
      showToast("请先播放或选择一句字幕");
      return;
    }
    setActiveSegment(index, true);
    setPlayback(false);
    clearRecordingAudio();
    elements.recordingPanel.hidden = false;
    elements.recordingStatus.textContent = "正在请求麦克风";
    showControls();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
        },
        video: false,
      });
      const mimeType = preferredRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined);
      const recording = {
        recorder,
        stream,
        chunks: [],
        startedAt: performance.now(),
        mimeType,
        index,
        storageKey: recordingStorageKey(episodeRecord, segment, index),
        seriesKey: episodeRecord.seriesKey,
        episodeStorageKey: episodeRecord.storageKey,
        projectId: episodeRecord.projectId,
        episodeNumber: episodeRecord.episodeNumber,
        episodeLabel: episodeRecord.episodeLabel,
        segmentId: Number(segment.id ?? index),
        segmentStart: Number(segment.start),
        japaneseText: japaneseText(segment),
        chineseText: chineseText(segment),
      };
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) recording.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const type = recorder.mimeType || mimeType || recording.chunks[0]?.type || "application/octet-stream";
        finishRecording(recording, new Blob(recording.chunks, { type }));
      }, { once: true });
      recorder.addEventListener("error", () => {
        showToast("录音过程中发生错误");
        stopCurrentRecording();
      });
      activeRecording = recording;
      recorder.start(250);
      recordingTimer = window.setInterval(() => {
        elements.recordingTime.textContent = formatRecordingTime(performance.now() - recording.startedAt);
      }, 100);
      startRecordingMeter(recording);
      renderRecordingState();
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      activeRecording = null;
      renderRecordingState();
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      showToast(denied ? "请允许网页使用麦克风后重试" : (error.message || "无法开始录音"));
    }
  }

  async function toggleRecordingPlayback() {
    if (activeRecording) return;
    if (!elements.recordingAudio.paused) {
      elements.recordingAudio.pause();
      return;
    }
    const saved = recordingForIndex(activeIndex);
    if (!saved) return;
    try {
      setPlayback(false);
      clearRecordingAudio();
      recordingAudioUrl = URL.createObjectURL(await recordingBlob(saved));
      elements.recordingAudio.src = recordingAudioUrl;
      await elements.recordingAudio.play();
    } catch (error) {
      showToast(error.message || "无法播放录音");
    }
  }

  async function deleteActiveRecording() {
    if (activeRecording) return;
    const saved = recordingForIndex(activeIndex);
    if (!saved || !window.confirm("删除当前字幕的录音？")) return;
    clearRecordingAudio();
    const database = await openDatabase();
    const transaction = database.transaction(RECORDING_STORE, "readwrite");
    transaction.objectStore(RECORDING_STORE).delete(saved.storageKey);
    await transactionDone(transaction);
    await removeRecordingFile(saved.fileName).catch(() => {});
    episodeRecordings.delete(saved.storageKey);
    syncRecordingMarks();
    renderRecordingState();
    showToast("录音已删除");
  }

  function updateTimeline() {
    if (!seeking) elements.timeline.value = String(elements.video.currentTime || 0);
    elements.currentTime.textContent = formatTime(elements.video.currentTime);
  }

  function showControls() {
    window.clearTimeout(controlsTimer);
    elements.playerShell.classList.remove("controls-hidden");
    if (!controlsPinned && !controlsInteracting && !activeRecording && elements.speedMenu.hidden) {
      controlsTimer = window.setTimeout(() => {
        if (controlsPinned || controlsInteracting || activeRecording || !elements.speedMenu.hidden) return;
        elements.playerShell.classList.add("controls-hidden");
      }, CONTROLS_HIDE_DELAY);
    }
  }

  function hideControls() {
    window.clearTimeout(controlsTimer);
    if (controlsPinned || controlsInteracting || activeRecording || !elements.speedMenu.hidden) return;
    elements.playerShell.classList.add("controls-hidden");
  }

  function holdControls() {
    window.clearTimeout(controlsReleaseTimer);
    controlsInteracting = true;
    window.clearTimeout(controlsTimer);
    elements.playerShell.classList.remove("controls-hidden");
  }

  function releaseControls() {
    if (!controlsInteracting) return;
    window.clearTimeout(controlsReleaseTimer);
    controlsReleaseTimer = window.setTimeout(() => {
      controlsInteracting = false;
      showControls();
    }, 0);
  }

  function applyPlaybackSpeed(value, persist = true) {
    const allowed = ["1", "0.9", "0.8", "0.7", "0.6", "0.5"];
    const normalized = allowed.includes(String(value)) ? String(value) : "1";
    playbackSpeed = Number(normalized);
    elements.video.playbackRate = playbackSpeed;
    elements.speedButton.textContent = `${playbackSpeed.toFixed(1)}×`;
    elements.speedMenu.querySelectorAll("[data-speed]").forEach((option) => {
      option.setAttribute("aria-selected", String(option.dataset.speed === normalized));
    });
    if (persist) writeSetting(SPEED_KEY, normalized);
  }

  function closeSpeedMenu(revealControls = true) {
    elements.speedMenu.hidden = true;
    elements.speedButton.setAttribute("aria-expanded", "false");
    if (revealControls) showControls();
  }

  function setControlsPinned(value, persist = true) {
    controlsPinned = Boolean(value);
    elements.controlsPinButton.setAttribute("aria-pressed", String(controlsPinned));
    elements.playerShell.classList.toggle("controls-pinned", controlsPinned);
    if (persist) writeSetting(CONTROLS_PINNED_KEY, String(controlsPinned));
    showControls();
  }

  function normalizedPaneWidth(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_PANE_WIDTH;
    return Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, number));
  }

  function applyPaneWidth(value, persist = true) {
    paneWidth = normalizedPaneWidth(value);
    document.body.style.setProperty("--video-pane-width", `${paneWidth}%`);
    elements.paneResizer.setAttribute("aria-valuenow", String(Math.round(paneWidth)));
    if (persist) writeSetting(PANE_WIDTH_KEY, paneWidth.toFixed(2));
  }

  function resizePanesAt(clientX, persist = false) {
    const bounds = elements.playerLayout.getBoundingClientRect();
    if (!bounds.width) return;
    applyPaneWidth(((clientX - bounds.left) / bounds.width) * 100, persist);
  }

  function stopPaneResize(event) {
    if (!resizingPanes) return;
    resizingPanes = false;
    elements.paneResizer.classList.remove("is-dragging");
    if (event?.pointerId !== undefined && elements.paneResizer.hasPointerCapture?.(event.pointerId)) {
      elements.paneResizer.releasePointerCapture(event.pointerId);
    }
    applyPaneWidth(paneWidth, true);
  }

  function syncPlaybackButton(isPlaying) {
    elements.playButton.textContent = isPlaying ? "❚❚" : "▶";
    elements.playButton.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
    elements.playButton.title = isPlaying ? "暂停" : "播放";
  }

  function setPlayback(shouldPlay, revealControls = true) {
    playbackIntent = shouldPlay;
    syncPlaybackButton(shouldPlay);
    if (!shouldPlay) {
      suppressNextPlayControls = false;
      elements.video.pause();
      if (revealControls) showControls();
      return;
    }
    suppressNextPlayControls = !revealControls;
    elements.video.play().then(() => {
      if (!playbackIntent) elements.video.pause();
      if (!revealControls && suppressNextPlayControls) {
        suppressNextPlayControls = false;
        hideControls();
      }
    }).catch(() => {
      playbackIntent = false;
      suppressNextPlayControls = false;
      syncPlaybackButton(false);
      showControls();
      showToast("无法开始播放");
    });
  }

  function togglePlayback(event) {
    event?.preventDefault();
    event?.stopPropagation();
    setPlayback(!playbackIntent);
  }

  function handlePlayPointerDown(event) {
    if (event.pointerType === "mouse") return;
    ignorePlayClick = true;
    window.setTimeout(() => { ignorePlayClick = false; }, 450);
    togglePlayback(event);
  }

  function handlePlayClick(event) {
    if (ignorePlayClick) {
      ignorePlayClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    togglePlayback(event);
  }

  function skip(seconds) {
    const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : Infinity;
    elements.video.currentTime = Math.max(0, Math.min(duration, elements.video.currentTime + seconds));
    if (repeatEnabled) repeatIndex = nearestSegmentIndex(elements.video.currentTime);
    showControls();
  }

  function episodeNumber(record) {
    const value = Number(record?.episodeNumber);
    return Number.isFinite(value) ? value : null;
  }

  function nextEpisode() {
    const current = episodeNumber(episodeRecord);
    if (current === null) return null;
    return seriesEpisodes.find((candidate) => episodeNumber(candidate) === current + 1) || null;
  }

  async function handleEnded() {
    savePlayback(true);
    if (repeatEnabled && repeatIndex >= 0) {
      seekToSegment(repeatIndex, true);
      return;
    }
    if (!elements.autoNext.checked) return;
    const next = nextEpisode();
    if (!next) {
      showToast("已经是最后一集");
      return;
    }
    try {
      await loadEpisode(next.seriesKey, next.projectId, true);
    } catch (error) {
      showToast(error.message || "下一集无法打开");
    }
  }

  async function loadEpisode(seriesKey, projectId, autoplay = false) {
    if (activeRecording) stopCurrentRecording();
    clearRecordingAudio();
    let record = await getRecord(EPISODE_STORE, storageKey(seriesKey, projectId));
    if (!record) {
      const allEpisodes = await getAllEpisodes();
      record = allEpisodes.find((candidate) => String(candidate.projectId) === String(projectId));
    }
    if (!record?.transcript || (!record.videoFileName && !record.videoBlob)) {
      throw new Error(missingEpisodeMessage());
    }
    seriesKey = record.seriesKey;
    projectId = record.projectId;
    const series = await getRecord(SERIES_STORE, seriesKey);
    if (!series) throw new Error("番剧项目信息不存在");
    const availableEpisodes = (await getAllEpisodes(seriesKey)).sort((left, right) => {
      const leftNumber = episodeNumber(left);
      const rightNumber = episodeNumber(right);
      if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
      return String(left.episodeLabel).localeCompare(String(right.episodeLabel), "zh-CN");
    });
    const storedVideo = await storedVideoBlob(record);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    episodeRecord = record;
    seriesRecord = series;
    seriesEpisodes = availableEpisodes;
    segments = normalizedSegments(record.transcript);
    episodeRecordings = new Map((await getEpisodeRecordings(record.storageKey)).map((item) => [item.storageKey, item]));
    activeIndex = -2;
    repeatIndex = -1;
    repeatEnabled = false;
    playbackIntent = false;
    syncPlaybackButton(false);
    configureSubtitleOverlay(record.transcript);
    elements.repeatButton.setAttribute("aria-pressed", "false");
    elements.seriesTitle.textContent = series.title;
    elements.episodeTitle.textContent = record.episodeLabel;
    document.title = `${record.episodeLabel} · ${series.title}`;
    renderTranscript();
    setActiveSegment(-1, false);
    videoUrl = URL.createObjectURL(storedVideo);
    elements.video.src = videoUrl;
    const playback = readPlayback(record);
    const startAt = playback.completed ? 0 : Math.max(0, Number(playback.position) || 0);
    await new Promise((resolve, reject) => {
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => {
        cleanup();
        const message = record.videoFileName
          ? "本地视频文件无法读取，请重新导入 .shadowing 项目包"
          : "旧版存储的视频无法读取，请返回项目列表重新导入同一个 .shadowing 项目包完成迁移";
        reject(new Error(message));
      };
      const cleanup = () => {
        elements.video.removeEventListener("loadedmetadata", loaded);
        elements.video.removeEventListener("error", failed);
      };
      elements.video.addEventListener("loadedmetadata", loaded);
      elements.video.addEventListener("error", failed);
      elements.video.load();
    });
    elements.timeline.max = String(elements.video.duration || record.duration || 0);
    elements.duration.textContent = formatTime(elements.video.duration || record.duration);
    elements.video.currentTime = Math.min(startAt, Math.max(0, elements.video.duration - 0.1));
    elements.video.playbackRate = playbackSpeed;
    setActiveSegment(findActiveIndex(elements.video.currentTime), false);
    history.replaceState(null, "", `./mobile-player.html?series=${encodeURIComponent(seriesKey)}&episode=${encodeURIComponent(projectId)}`);
    elements.playerError.hidden = true;
    elements.playerLayout.hidden = false;
    showControls();
    if (autoplay) setPlayback(true);
  }

  async function loadInitialEpisode() {
    const parameters = new URLSearchParams(location.search);
    let seriesKey = parameters.get("series");
    let projectId = parameters.get("episode");
    if (!seriesKey || !projectId) {
      const all = await getAllEpisodes();
      const first = all.sort((left, right) => String(right.importedAt).localeCompare(String(left.importedAt)))[0];
      if (!first) throw new Error("手机中还没有跟读项目");
      seriesKey = first.seriesKey;
      projectId = first.projectId;
    }
    await loadEpisode(seriesKey, projectId, false);
  }

  elements.playButton.addEventListener("pointerdown", handlePlayPointerDown);
  elements.playButton.addEventListener("click", handlePlayClick);
  elements.backButton.addEventListener("click", () => skip(-1));
  elements.forwardButton.addEventListener("click", () => skip(1));
  elements.repeatButton.addEventListener("click", () => {
    repeatEnabled = !repeatEnabled;
    repeatIndex = repeatEnabled ? nearestSegmentIndex(elements.video.currentTime) : -1;
    if (repeatEnabled && repeatIndex < 0) {
      repeatEnabled = false;
      showToast("当前位置没有可循环的字幕");
    }
    elements.repeatButton.setAttribute("aria-pressed", String(repeatEnabled));
    showControls();
  });
  elements.recordButton.addEventListener("click", startRecording);
  elements.recordingPlayButton.addEventListener("click", toggleRecordingPlayback);
  elements.recordingDeleteButton.addEventListener("click", () => {
    deleteActiveRecording().catch((error) => showToast(error.message || "无法删除录音"));
  });
  elements.recordingAudio.addEventListener("play", () => {
    elements.recordingPlayButton.textContent = "❚❚";
    elements.recordingPlayButton.setAttribute("aria-label", "暂停这条录音");
    showControls();
  });
  elements.recordingAudio.addEventListener("pause", () => {
    elements.recordingPlayButton.textContent = "▶";
    elements.recordingPlayButton.setAttribute("aria-label", "播放这条录音");
  });
  applyPlaybackSpeed(readSetting(SPEED_KEY, "1"), false);
  elements.speedButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opening = elements.speedMenu.hidden;
    if (!opening) {
      closeSpeedMenu();
      return;
    }
    holdControls();
    elements.speedMenu.hidden = false;
    elements.speedButton.setAttribute("aria-expanded", "true");
  });
  elements.speedMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-speed]");
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    applyPlaybackSpeed(option.dataset.speed);
    closeSpeedMenu();
  });
  document.addEventListener("click", (event) => {
    if (elements.speedMenu.hidden || elements.speedControl.contains(event.target)) return;
    closeSpeedMenu(false);
  });
  elements.controlsPinButton.addEventListener("click", () => setControlsPinned(!controlsPinned));
  setControlsPinned(readSetting(CONTROLS_PINNED_KEY, "false") === "true", false);
  applyPaneWidth(readSetting(PANE_WIDTH_KEY, String(DEFAULT_PANE_WIDTH)), false);
  elements.paneResizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizingPanes = true;
    elements.paneResizer.classList.add("is-dragging");
    elements.paneResizer.setPointerCapture?.(event.pointerId);
    resizePanesAt(event.clientX, false);
  });
  elements.paneResizer.addEventListener("pointermove", (event) => {
    if (!resizingPanes) return;
    event.preventDefault();
    resizePanesAt(event.clientX, false);
  });
  elements.paneResizer.addEventListener("pointerup", stopPaneResize);
  elements.paneResizer.addEventListener("pointercancel", stopPaneResize);
  elements.paneResizer.addEventListener("keydown", (event) => {
    let next = paneWidth;
    if (event.key === "ArrowLeft") next -= 2;
    else if (event.key === "ArrowRight") next += 2;
    else if (event.key === "Home") next = MIN_PANE_WIDTH;
    else if (event.key === "End") next = MAX_PANE_WIDTH;
    else return;
    event.preventDefault();
    applyPaneWidth(next, true);
  });
  elements.autoNext.checked = readSetting(AUTO_NEXT_KEY, "false") === "true";
  elements.autoNext.addEventListener("change", () => writeSetting(AUTO_NEXT_KEY, elements.autoNext.checked));
  elements.timeline.addEventListener("pointerdown", () => { seeking = true; });
  elements.timeline.addEventListener("input", () => {
    elements.currentTime.textContent = formatTime(elements.timeline.value);
    elements.video.currentTime = Number(elements.timeline.value) || 0;
    setActiveSegment(findActiveIndex(elements.video.currentTime), false);
  });
  elements.timeline.addEventListener("change", () => {
    seeking = false;
    if (repeatEnabled) repeatIndex = nearestSegmentIndex(elements.video.currentTime);
    schedulePlaybackSave();
    showControls();
  });
  elements.video.addEventListener("timeupdate", () => {
    if (repeatEnabled && repeatIndex >= 0) {
      const target = segments[repeatIndex];
      if (target && elements.video.currentTime >= target.end - 0.025) {
        elements.video.currentTime = target.start;
        if (!elements.video.paused) elements.video.play().catch(() => {});
        return;
      }
    }
    updateTimeline();
    setActiveSegment(findActiveIndex(elements.video.currentTime), true);
    schedulePlaybackSave();
  });
  elements.video.addEventListener("play", () => {
    playbackIntent = true;
    syncPlaybackButton(true);
    if (suppressNextPlayControls) {
      suppressNextPlayControls = false;
      hideControls();
      return;
    }
    showControls();
  });
  elements.video.addEventListener("pause", () => {
    playbackIntent = false;
    syncPlaybackButton(false);
    showControls();
    savePlayback(false);
  });
  elements.video.addEventListener("ended", handleEnded);
  elements.playerControls.addEventListener("pointerdown", holdControls);
  window.addEventListener("pointerup", releaseControls);
  window.addEventListener("pointercancel", releaseControls);
  elements.playerShell.addEventListener("pointermove", showControls);
  elements.playerShell.addEventListener("pointerleave", () => {
    if (!controlsPinned && !controlsInteracting && !activeRecording && elements.speedMenu.hidden) showControls();
  });
  elements.playerShell.addEventListener("click", (event) => {
    if (event.target.closest(".player-controls")) return;
    showControls();
  });
  elements.fullscreenButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (elements.playerShell.requestFullscreen) await elements.playerShell.requestFullscreen();
      else if (elements.video.webkitEnterFullscreen) elements.video.webkitEnterFullscreen();
    } catch (_error) {
      showToast("当前浏览器无法进入全屏");
    }
  });
  document.addEventListener("fullscreenchange", showControls);
  window.addEventListener("pagehide", () => {
    stopCurrentRecording();
    savePlayback(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCurrentRecording();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !episodeRecord) return;
    if (elements.video.error || !elements.video.src) {
      loadEpisode(episodeRecord.seriesKey, episodeRecord.projectId, false)
        .catch((error) => showError(error.message || "无法恢复本地视频"));
      return;
    }
    elements.playerError.hidden = true;
    elements.playerLayout.hidden = false;
    showControls();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./mobile-sw.js").catch(() => {});
  loadInitialEpisode().catch((error) => showError(error.message || "无法读取本地项目"));
}());

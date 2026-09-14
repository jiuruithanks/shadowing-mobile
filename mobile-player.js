(function initMobilePlayer() {
  "use strict";

  const DB_NAME = "tokyo-shadowing-mobile";
  const DB_VERSION = 1;
  const SERIES_STORE = "series";
  const EPISODE_STORE = "episodes";
  const VIDEO_DIRECTORY = "videos";
  const AUTO_NEXT_KEY = "tokyo-shadowing:auto-next";
  const SPEED_KEY = "tokyo-shadowing:playback-speed";
  const CONTROLS_HIDE_DELAY = 1100;
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
    playerControls: document.querySelector("#playerControls"),
    timeline: document.querySelector("#timeline"),
    currentTime: document.querySelector("#currentTime"),
    duration: document.querySelector("#duration"),
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
  let progressSaveTimer;
  let toastTimer;
  let seeking = false;
  let playbackIntent = false;
  let ignorePlayClick = false;
  let controlsInteracting = false;
  let repeatWasPlaying = false;
  let speedWasPlaying = false;
  let playbackSpeed = 1;

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

  function storageKey(seriesKey, projectId) {
    return `${seriesKey}\u001f${projectId}`;
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
      return;
    }
    const segment = segments[index];
    elements.overlayJapanese.textContent = overlayJapaneseFromEmbedded ? japaneseText(segment) : "";
    elements.overlayChinese.textContent = overlayChineseFromEmbedded ? chineseText(segment) : "";
    const row = elements.transcriptList.querySelector(`[data-index="${index}"]`);
    row?.classList.add("is-active");
    if (scroll && row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function seekToSegment(index, autoplay = false) {
    const segment = segments[index];
    if (!segment) return;
    elements.video.currentTime = segment.start;
    setActiveSegment(index, true);
    if (repeatEnabled) repeatIndex = index;
    showControls();
    if (autoplay) setPlayback(true);
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
      row.append(time, copy);
      row.addEventListener("click", () => seekToSegment(index, false));
      fragment.append(row);
    });
    elements.transcriptList.replaceChildren(fragment);
  }

  function updateTimeline() {
    if (!seeking) elements.timeline.value = String(elements.video.currentTime || 0);
    elements.currentTime.textContent = formatTime(elements.video.currentTime);
  }

  function showControls() {
    window.clearTimeout(controlsTimer);
    elements.playerShell.classList.remove("controls-hidden");
    if (!controlsInteracting && (!elements.video.paused || playbackIntent)) {
      controlsTimer = window.setTimeout(() => {
        elements.playerShell.classList.add("controls-hidden");
      }, CONTROLS_HIDE_DELAY);
    }
  }

  function holdControls() {
    controlsInteracting = true;
    window.clearTimeout(controlsTimer);
    elements.playerShell.classList.remove("controls-hidden");
  }

  function releaseControls(event) {
    if (!controlsInteracting) return;
    if (!elements.speedMenu.hidden) return;
    controlsInteracting = false;
    showControls();
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

  function closeSpeedMenu() {
    elements.speedMenu.hidden = true;
    elements.speedButton.setAttribute("aria-expanded", "false");
    controlsInteracting = false;
    showControls();
  }

  function rememberRepeatPlayback() {
    repeatWasPlaying = repeatWasPlaying || playbackIntent || !elements.video.paused;
  }

  function syncPlaybackButton(isPlaying) {
    elements.playButton.textContent = isPlaying ? "❚❚" : "▶";
    elements.playButton.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
    elements.playButton.title = isPlaying ? "暂停" : "播放";
  }

  function setPlayback(shouldPlay) {
    playbackIntent = shouldPlay;
    syncPlaybackButton(shouldPlay);
    if (!shouldPlay) {
      elements.video.pause();
      showControls();
      return;
    }
    elements.video.play().then(() => {
      if (!playbackIntent) elements.video.pause();
    }).catch(() => {
      playbackIntent = false;
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
  elements.repeatButton.addEventListener("pointerdown", rememberRepeatPlayback);
  elements.repeatButton.addEventListener("touchstart", rememberRepeatPlayback, { passive: true });
  elements.repeatButton.addEventListener("click", () => {
    const shouldContinuePlaying = repeatWasPlaying || playbackIntent || !elements.video.paused;
    repeatEnabled = !repeatEnabled;
    repeatIndex = repeatEnabled ? nearestSegmentIndex(elements.video.currentTime) : -1;
    if (repeatEnabled && repeatIndex < 0) {
      repeatEnabled = false;
      showToast("当前位置没有可循环的字幕");
    }
    elements.repeatButton.setAttribute("aria-pressed", String(repeatEnabled));
    if (shouldContinuePlaying) setPlayback(true);
    repeatWasPlaying = false;
    showControls();
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
    speedWasPlaying = playbackIntent || !elements.video.paused;
    holdControls();
    elements.speedMenu.hidden = false;
    elements.speedButton.setAttribute("aria-expanded", "true");
  });
  elements.speedMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-speed]");
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    const shouldContinuePlaying = speedWasPlaying || playbackIntent || !elements.video.paused;
    applyPlaybackSpeed(option.dataset.speed);
    closeSpeedMenu();
    if (shouldContinuePlaying) setPlayback(true);
    speedWasPlaying = false;
  });
  document.addEventListener("click", (event) => {
    if (elements.speedMenu.hidden || elements.speedControl.contains(event.target)) return;
    closeSpeedMenu();
    speedWasPlaying = false;
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
    if (!elements.video.paused && !controlsInteracting) elements.playerShell.classList.add("controls-hidden");
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
    savePlayback(false);
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

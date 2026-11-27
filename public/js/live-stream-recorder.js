/**
 * Multitrack Direct-to-SSD Recorder, State Machine, Local Session Storage & Direct-to-R2 Publisher
 * Streams pre-FX 24-bit/48kHz discrete WAV stems + post-FX live reference MP3 to:
 *   1) User-picked SSD Folder: <PickedFolder>/BhajanPlanner/Recordings/YYYY-MM-DD/<session-uid>/
 *   2) Automatic Default SSD Vault (OPFS, zero-prompt fallback):
 *      BhajanPlanner/Recordings/YYYY-MM-DD/<session-uid>/
 * Supports direct browser -> Cloudflare R2 SigV4 presigned PUT uploads (0 audio bytes via Railway)
 * with automatic multipart fallback, crash/refresh WAV recovery, and offline upload queue tracking.
 */
(function (rootScope, factory) {
  const api = factory(rootScope);
  if (rootScope && typeof rootScope === "object") {
    rootScope.LiveStudioRecorder = api;
  }
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : self),
  function (window) {
    "use strict";

    const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
    const SINGLE_PUT_LIMIT_BYTES = 8 * 1024 * 1024;
    const PENDING_QUEUE_KEY = "bp_studio_pending_r2_uploads";
    const RECOVERY_META_KEY = "bp_studio_last_recording_recovery";
    const FS_HANDLE_DB = "bp_studio_fs_handles_v1";
    const FS_HANDLE_STORE = "dir_handles";
    const DEFAULT_SSD_HANDLE_KEY = "default_ssd_dir";
    const WavUtils =
      (typeof require === "function" ? require("./live-stream-wav-utils") : null) ||
      window.LiveStreamWavUtils;

    let selectedDirHandle = null;
    let savedPendingDirHandle = null;
    let activeSessionDirHandle = null;
    let testOpfsRootOverride = null;
    let persistRequested = false;
    let recordingState = null;
    let lastSessionUid = null;
    let machineState = "idle"; // idle | preflight | recording | finalizing | verified | error
    let writeChain = Promise.resolve();
    let headerSyncTimer = null;

    function makeFileBlob(parts, filename, type) {
      if (typeof File === "function") {
        return new File(parts, filename, { type });
      }
      const blob = new Blob(parts, { type });
      blob.name = filename;
      return blob;
    }

    function setTestOpfsRoot(rootHandle) {
      testOpfsRootOverride = rootHandle || null;
    }

    function isOpfsVaultSupported() {
      if (testOpfsRootOverride) return true;
      return (
        typeof navigator !== "undefined" &&
        Boolean(navigator.storage) &&
        typeof navigator.storage.getDirectory === "function"
      );
    }

    async function getDefaultOpfsRoot(overrideRoot) {
      if (overrideRoot) return overrideRoot;
      if (testOpfsRootOverride) return testOpfsRootOverride;
      if (
        typeof navigator !== "undefined" &&
        navigator.storage &&
        typeof navigator.storage.getDirectory === "function"
      ) {
        if (!persistRequested && typeof navigator.storage.persist === "function") {
          persistRequested = true;
          navigator.storage.persist().catch(() => { });
        }
        try {
          return await navigator.storage.getDirectory();
        } catch (err) {
          console.warn("[LiveRecorder] Default OPFS SSD Vault unavailable:", err.message);
          return null;
        }
      }
      return null;
    }

    function openHandleDb() {
      return new Promise((resolve, reject) => {
        if (typeof window === "undefined" || !window.indexedDB) {
          reject(new Error("IndexedDB unavailable"));
          return;
        }
        const req = window.indexedDB.open(FS_HANDLE_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(FS_HANDLE_STORE)) {
            db.createObjectStore(FS_HANDLE_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB handle DB open failed"));
      });
    }

    async function saveDirectoryHandle(handle) {
      if (!handle || typeof window === "undefined" || !window.indexedDB) return false;
      try {
        const db = await openHandleDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(FS_HANDLE_STORE, "readwrite");
          tx.objectStore(FS_HANDLE_STORE).put(handle, DEFAULT_SSD_HANDLE_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
        return true;
      } catch (_) {
        return false;
      }
    }

    async function loadSavedDirectoryHandle() {
      if (typeof window === "undefined" || !window.indexedDB) return null;
      try {
        const db = await openHandleDb();
        const handle = await new Promise((resolve, reject) => {
          const tx = db.transaction(FS_HANDLE_STORE, "readonly");
          const req = tx.objectStore(FS_HANDLE_STORE).get(DEFAULT_SSD_HANDLE_KEY);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
        db.close();
        return handle;
      } catch (_) {
        return null;
      }
    }

    async function restoreSavedDirectory({ requestIfNeeded = false } = {}) {
      if (selectedDirHandle) {
        return { restored: true, pendingPermission: false, name: selectedDirHandle.name };
      }
      const handle = savedPendingDirHandle || (await loadSavedDirectoryHandle());
      if (!handle) {
        return { restored: false, pendingPermission: false, name: null };
      }
      try {
        if (typeof handle.queryPermission === "function") {
          let perm = await handle.queryPermission({ mode: "readwrite" });
          if (perm !== "granted" && requestIfNeeded && typeof handle.requestPermission === "function") {
            perm = await handle.requestPermission({ mode: "readwrite" });
          }
          if (perm === "granted") {
            selectedDirHandle = handle;
            savedPendingDirHandle = null;
            return { restored: true, pendingPermission: false, name: handle.name };
          }
          savedPendingDirHandle = handle;
          return { restored: false, pendingPermission: true, name: handle.name };
        }
        selectedDirHandle = handle;
        savedPendingDirHandle = null;
        return { restored: true, pendingPermission: false, name: handle.name || null };
      } catch (_) {
        return { restored: false, pendingPermission: false, name: null };
      }
    }

    function enqueueWrite(task) {
      writeChain = writeChain.then(task).catch((err) => {
        console.error("[LiveRecorder] Disk write error:", err);
        if (recordingState) {
          recordingState.writeErrorCount = (recordingState.writeErrorCount || 0) + 1;
          recordingState.lastWriteError = err.message || String(err);
        }
      });
      return writeChain;
    }

    async function writeHeaderAtStart(writable, sampleRate, bitDepth, dataByteLength) {
      if (!writable) return;
      const header = WavUtils.buildWavHeader({
        sampleRate,
        numChannels: 1,
        bitDepth,
        dataByteLength
      });
      await writable.write({ type: "write", position: 0, data: header });
    }

    function isFileSystemApiSupported() {
      return typeof window.showDirectoryPicker === "function";
    }

    async function pickDirectory() {
      if (!isFileSystemApiSupported()) {
        return { ok: false, fallbackOnly: true, name: null };
      }
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      selectedDirHandle = handle;
      savedPendingDirHandle = null;
      await saveDirectoryHandle(handle);
      return { ok: true, fallbackOnly: false, name: handle.name };
    }

    function getDirectoryName() {
      return selectedDirHandle ? selectedDirHandle.name : null;
    }

    function getStorageSummary() {
      const mode = selectedDirHandle
        ? "user_folder"
        : isOpfsVaultSupported()
          ? "opfs_vault"
          : "memory";
      return {
        mode,
        folderName: getDirectoryName(),
        savedPendingName: savedPendingDirHandle ? savedPendingDirHandle.name : null,
        vaultPath: "BhajanPlanner/Recordings"
      };
    }

    function getState() {
      const summary = getStorageSummary();
      return {
        state: machineState,
        active: isRecording(),
        projectUid: recordingState ? recordingState.sessionUid : lastSessionUid,
        folderName: getDirectoryName(),
        storageBackend: recordingState ? recordingState.storageBackend : summary.mode,
        savedPendingName: summary.savedPendingName,
        droppedFrames: recordingState ? (recordingState.droppedFrames || 0) : 0,
        writeErrorCount: recordingState ? (recordingState.writeErrorCount || 0) : 0,
        sampleSyncDriftFrames: recordingState
          ? Math.abs((recordingState.ch1Samples || 0) - (recordingState.ch2Samples || 0))
          : 0,
        offlineQueueCount: getPendingUploads().length
      };
    }

    function isRecording() {
      return Boolean(recordingState && recordingState.active);
    }

    async function getDiskEstimate() {
      try {
        if (navigator.storage && typeof navigator.storage.estimate === "function") {
          const est = await navigator.storage.estimate();
          const quota = Number(est.quota) || 0;
          const usage = Number(est.usage) || 0;
          const availableBytes = Math.max(0, quota - usage);
          return { supported: true, quotaBytes: quota, usedBytes: usage, availableBytes };
        }
      } catch (_) { }
      return { supported: false, quotaBytes: 0, usedBytes: 0, availableBytes: null };
    }

    async function resolveSessionDirectory(rootHandle, sessionDate, sessionUid) {
      if (!rootHandle) return null;
      if (typeof rootHandle.getDirectoryHandle !== "function") return rootHandle;
      try {
        const rootLower = String(rootHandle.name || "").trim().toLowerCase();
        const baseDir = rootLower === "bhajanplanner"
          ? rootHandle
          : await rootHandle.getDirectoryHandle("BhajanPlanner", { create: true });
        const recDir = await baseDir.getDirectoryHandle("Recordings", { create: true });
        const dateDir = await recDir.getDirectoryHandle(sessionDate, { create: true });
        const sessDir = await dateDir.getDirectoryHandle(sessionUid, { create: true });
        return sessDir;
      } catch (_) {
        return rootHandle;
      }
    }

    async function writeFileInSessionDir(filename, content) {
      const dir = activeSessionDirHandle || selectedDirHandle;
      if (!dir || typeof dir.getFileHandle !== "function") return false;
      try {
        const fh = await dir.getFileHandle(filename, { create: true });
        const wr = await fh.createWritable();
        await wr.write(content);
        await wr.close();
        return true;
      } catch (err) {
        console.warn("[LiveRecorder] Could not write session artifact:", filename, err.message);
        return false;
      }
    }

    async function readFileFromSessionDir(filename) {
      const dir = activeSessionDirHandle || selectedDirHandle;
      if (!dir || typeof dir.getFileHandle !== "function") return null;
      try {
        const fh = await dir.getFileHandle(filename, { create: false });
        return await fh.getFile();
      } catch (_) {
        return null;
      }
    }

    async function saveWaveformCache(cacheKey, cacheObj) {
      const dir = activeSessionDirHandle || selectedDirHandle;
      if (!dir || typeof dir.getDirectoryHandle !== "function") return false;
      try {
        const cacheDir = await dir.getDirectoryHandle("waveform-cache", { create: true });
        const safeKey = String(cacheKey || "stems").replace(/[^a-zA-Z0-9._-]/g, "_") + ".json";
        const fh = await cacheDir.getFileHandle(safeKey, { create: true });
        const wr = await fh.createWritable();
        await wr.write(JSON.stringify(cacheObj));
        await wr.close();
        return true;
      } catch (_) {
        return false;
      }
    }

    async function loadWaveformCache(cacheKey) {
      const dir = activeSessionDirHandle || selectedDirHandle;
      if (!dir || typeof dir.getDirectoryHandle !== "function") return null;
      try {
        const cacheDir = await dir.getDirectoryHandle("waveform-cache", { create: false });
        const safeKey = String(cacheKey || "stems").replace(/[^a-zA-Z0-9._-]/g, "_") + ".json";
        const fh = await cacheDir.getFileHandle(safeKey, { create: false });
        const file = await fh.getFile();
        return JSON.parse(await file.text());
      } catch (_) {
        return null;
      }
    }

    function getStats() {
      if (!recordingState) {
        return {
          state: machineState,
          active: false,
          elapsedSeconds: 0,
          elapsedSampleSeconds: 0,
          sampleFrames: 0,
          ch1Samples: 0,
          ch2Samples: 0,
          sampleSyncDriftFrames: 0,
          totalBytes: 0,
          dryCh1Bytes: 0,
          dryCh2Bytes: 0,
          masterBytes: 0,
          writeErrorCount: 0
        };
      }
      const wallSec = recordingState.startedAt
        ? Math.max(0, Math.floor((Date.now() - recordingState.startedAt) / 1000))
        : 0;
      const sampleSecExact = recordingState.sampleRate > 0 && recordingState.totalFrames > 0
        ? recordingState.totalFrames / recordingState.sampleRate
        : wallSec;
      const sampleSec = Math.floor(sampleSecExact);
      return {
        state: machineState,
        active: recordingState.active,
        sessionUid: recordingState.sessionUid,
        elapsedSeconds: recordingState.totalFrames > 0 ? sampleSec : wallSec,
        elapsedSampleSeconds: sampleSecExact,
        sampleFrames: recordingState.totalFrames,
        ch1Samples: recordingState.ch1Samples || 0,
        ch2Samples: recordingState.ch2Samples || 0,
        sampleSyncDriftFrames: Math.abs((recordingState.ch1Samples || 0) - (recordingState.ch2Samples || 0)),
        totalBytes:
          recordingState.dryCh1Bytes +
          recordingState.dryCh2Bytes +
          recordingState.masterBytes,
        dryCh1Bytes: recordingState.dryCh1Bytes,
        dryCh2Bytes: recordingState.dryCh2Bytes,
        masterBytes: recordingState.masterBytes,
        writeErrorCount: recordingState.writeErrorCount || 0,
        lastWriteError: recordingState.lastWriteError || null
      };
    }

    async function startRecording(options = {}) {
      if (isRecording()) {
        throw new Error("Recording is already active.");
      }

      machineState = "preflight";
      const diskInfo = await getDiskEstimate();
      if (diskInfo.supported && diskInfo.availableBytes !== null && diskInfo.availableBytes < 120 * 1024 * 1024) {
        machineState = "error";
        throw new Error("Insufficient browser/local disk quota (< 120 MB free). Free SSD space before recording.");
      }

      const sessionDate =
        options.sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(options.sessionDate)
          ? options.sessionDate
          : new Date().toISOString().slice(0, 10);
      const sessionUid = options.sessionUid || `${sessionDate}_Satsang_${Date.now().toString(36)}`;
      lastSessionUid = sessionUid;
      const bitDepth = [16, 24, 32].includes(Number(options.bitDepth)) ? Number(options.bitDepth) : 24;
      const sampleRate = Number(options.sampleRate) || 48000;
      const publishBitrateKbps = Number(options.publishBitrateKbps) || 192;
      const recordDryCh1 = options.recordDryCh1 !== false;
      const recordDryCh2 = options.recordDryCh2 !== false;
      const recordMasterMp3 = options.recordMasterMp3 !== false;

      if (!selectedDirHandle && savedPendingDirHandle && typeof savedPendingDirHandle.queryPermission === "function") {
        try {
          const perm = await savedPendingDirHandle.queryPermission({ mode: "readwrite" });
          if (perm === "granted") {
            selectedDirHandle = savedPendingDirHandle;
            savedPendingDirHandle = null;
          }
        } catch (_) { }
      }

      const opfsRoot = selectedDirHandle ? null : await getDefaultOpfsRoot(options.opfsRootHandle);
      const rootHandle = selectedDirHandle || opfsRoot || null;
      const storageBackend = selectedDirHandle ? "user_folder" : (opfsRoot ? "opfs_vault" : "memory");

      const ch1Filename = options.ch1Filename || (rootHandle ? "Ch1_Vocals_DRY.wav" : `${sessionDate}_Ch1_Vocals_DRY.wav`);
      const ch2Filename = options.ch2Filename || (rootHandle ? "Ch2_Instruments_DRY.wav" : `${sessionDate}_Ch2_Instruments_DRY.wav`);
      const masterFilename = options.masterFilename || (rootHandle ? "Live_Reference.mp3" : `${sessionDate}_Live_Reference_${publishBitrateKbps}k.mp3`);

      const st = {
        active: true,
        storageBackend,
        hasDiskRoot: Boolean(rootHandle),
        sessionDate,
        sessionUid,
        bitDepth,
        sampleRate,
        publishBitrateKbps,
        hardwareCaptureFormat: options.hardwareCaptureFormat || {
          driver: "Browser WASAPI",
          sampleRate,
          channelCount: 2,
          sampleSizeBits: null,
          exportBitDepth: bitDepth
        },
        recordDryCh1,
        recordDryCh2,
        recordMasterMp3,
        ch1Filename,
        ch2Filename,
        masterFilename,
        startedAt: Date.now(),
        clockOriginFrames: null,
        totalFrames: 0,
        ch1Samples: 0,
        ch2Samples: 0,
        droppedFrames: 0,
        dryCh1Bytes: 0,
        dryCh2Bytes: 0,
        ch1WritePos: 44,
        ch2WritePos: 44,
        masterBytes: 0,
        writeErrorCount: 0,
        lastWriteError: null,
        ch1Writable: null,
        ch2Writable: null,
        ch1FileHandle: null,
        ch2FileHandle: null,
        masterWritable: null,
        masterFileHandle: null,
        fallbackCh1Chunks: [],
        fallbackCh2Chunks: [],
        fallbackMasterChunks: [],
        worker: null,
        flushResolver: null
      };

      if (rootHandle) {
        activeSessionDirHandle = await resolveSessionDirectory(rootHandle, sessionDate, sessionUid);
        const targetDir = activeSessionDirHandle || rootHandle;
        if (recordDryCh1) {
          st.ch1FileHandle = await targetDir.getFileHandle(ch1Filename, { create: true });
          st.ch1Writable = await st.ch1FileHandle.createWritable();
          await writeHeaderAtStart(st.ch1Writable, sampleRate, bitDepth, 0);
        }
        if (recordDryCh2) {
          st.ch2FileHandle = await targetDir.getFileHandle(ch2Filename, { create: true });
          st.ch2Writable = await st.ch2FileHandle.createWritable();
          await writeHeaderAtStart(st.ch2Writable, sampleRate, bitDepth, 0);
        }
        if (recordMasterMp3) {
          st.masterFileHandle = await targetDir.getFileHandle(masterFilename, { create: true });
          st.masterWritable = await st.masterFileHandle.createWritable();
        }
      }

      if (recordMasterMp3 && typeof Worker === "function") {
        const worker = new Worker("/js/live-stream-encoder-worker.js?v=1.0");
        worker.onmessage = function (ev) {
          const msg = ev.data;
          if (!msg) return;
          if (msg.type === "chunk" && msg.buffer) {
            const u8 = new Uint8Array(msg.buffer);
            st.masterBytes += u8.byteLength;
            if (st.masterWritable) {
              enqueueWrite(() => st.masterWritable.write(u8));
            } else {
              st.fallbackMasterChunks.push(u8);
            }
          } else if (msg.type === "flushed" && st.flushResolver) {
            const r = st.flushResolver;
            st.flushResolver = null;
            r();
          }
        };
        worker.postMessage({
          type: "init",
          channels: 2,
          sampleRate,
          kbps: publishBitrateKbps
        });
        st.worker = worker;
      }

      recordingState = st;
      machineState = "recording";
      writeChain = Promise.resolve();

      try {
        if (window.localStorage) {
          window.localStorage.setItem(RECOVERY_META_KEY, JSON.stringify({
            sessionUid,
            sessionDate,
            storageBackend,
            startedAt: st.startedAt,
            sampleRate,
            bitDepth,
            ch1Filename,
            ch2Filename,
            masterFilename,
            active: true
          }));
        }
      } catch (_) { }

      clearInterval(headerSyncTimer);
      if (rootHandle && (recordDryCh1 || recordDryCh2)) {
        headerSyncTimer = setInterval(() => {
          if (!recordingState || !recordingState.active) return;
          enqueueWrite(async () => {
            if (recordingState.ch1Writable) {
              await writeHeaderAtStart(
                recordingState.ch1Writable,
                recordingState.sampleRate,
                recordingState.bitDepth,
                recordingState.dryCh1Bytes
              );
            }
            if (recordingState.ch2Writable) {
              await writeHeaderAtStart(
                recordingState.ch2Writable,
                recordingState.sampleRate,
                recordingState.bitDepth,
                recordingState.dryCh2Bytes
              );
            }
            await writeFileInSessionDir(
              "project.checkpoint.json",
              JSON.stringify({
                sessionUid: recordingState.sessionUid,
                sessionDate: recordingState.sessionDate,
                storageBackend: recordingState.storageBackend,
                sampleRate: recordingState.sampleRate,
                bitDepth: recordingState.bitDepth,
                hardwareCaptureFormat: recordingState.hardwareCaptureFormat,
                totalFrames: recordingState.totalFrames,
                ch1Samples: recordingState.ch1Samples,
                ch2Samples: recordingState.ch2Samples,
                sampleSyncDriftFrames: Math.abs((recordingState.ch1Samples || 0) - (recordingState.ch2Samples || 0)),
                dryCh1Bytes: recordingState.dryCh1Bytes,
                dryCh2Bytes: recordingState.dryCh2Bytes,
                masterBytes: recordingState.masterBytes,
                savedAt: new Date().toISOString()
              }, null, 2)
            );
          });
        }, 15000);
      }

      return getStats();
    }

    function pushDryPcm(ch1Float, ch2Float, totalFramesFromClock) {
      const st = recordingState;
      if (!st || !st.active) return;

      const blockLen = ch1Float && ch1Float.length > 0
        ? ch1Float.length
        : (ch2Float && ch2Float.length > 0 ? ch2Float.length : 0);

      if (Number.isFinite(totalFramesFromClock) && totalFramesFromClock > 0) {
        if (st.clockOriginFrames === null) {
          st.clockOriginFrames = Math.max(0, totalFramesFromClock - blockLen);
        }
        const relativeFrames = Math.max(0, totalFramesFromClock - st.clockOriginFrames);
        if (relativeFrames > st.totalFrames) {
          st.totalFrames = relativeFrames;
        }
      } else if (blockLen > 0) {
        st.totalFrames += blockLen;
      }

      if (st.recordDryCh1 && ch1Float && ch1Float.length > 0) {
        st.ch1Samples += ch1Float.length;
        const bytes1 = WavUtils.floatToPcmBytes(ch1Float, st.bitDepth);
        const pos1 = st.ch1WritePos;
        st.ch1WritePos += bytes1.byteLength;
        st.dryCh1Bytes += bytes1.byteLength;
        if (st.ch1Writable) {
          enqueueWrite(() => st.ch1Writable.write({ type: "write", position: pos1, data: bytes1 }));
        } else {
          st.fallbackCh1Chunks.push(bytes1);
        }
      }

      if (st.recordDryCh2 && ch2Float && ch2Float.length > 0) {
        st.ch2Samples += ch2Float.length;
        const bytes2 = WavUtils.floatToPcmBytes(ch2Float, st.bitDepth);
        const pos2 = st.ch2WritePos;
        st.ch2WritePos += bytes2.byteLength;
        st.dryCh2Bytes += bytes2.byteLength;
        if (st.ch2Writable) {
          enqueueWrite(() => st.ch2Writable.write({ type: "write", position: pos2, data: bytes2 }));
        } else {
          st.fallbackCh2Chunks.push(bytes2);
        }
      }
    }

    function pushMasterPcm(leftInt16, rightInt16) {
      const st = recordingState;
      if (!st || !st.active || !st.worker || !st.recordMasterMp3) return;
      const lCopy = new Int16Array(leftInt16);
      const rCopy = new Int16Array(rightInt16 || leftInt16);
      st.worker.postMessage(
        { type: "encode", left: lCopy, right: rCopy },
        [lCopy.buffer, rCopy.buffer]
      );
    }

    async function verifyStemFile(file) {
      if (!file || typeof file.slice !== "function" || typeof WavUtils.verifyWavHeaderAndSize !== "function") {
        return { valid: Boolean(file && file.size > 44), byteLength: file ? file.size : 0 };
      }
      try {
        const headBuf = await file.slice(0, Math.min(file.size, 256)).arrayBuffer();
        // Header's data chunk may exceed 256 bytes, so pass actual size comparison separately
        const headerView = new DataView(headBuf);
        if (headBuf.byteLength < 44) return { valid: false, error: "File header < 44 bytes" };
        const dataChunkSize = headerView.getUint32(40, true);
        const matches = dataChunkSize > 0 && file.size >= 44 + dataChunkSize;
        return {
          valid: matches,
          byteLength: file.size,
          dataBytes: dataChunkSize,
          error: matches ? null : `WAV mismatch: declared ${dataChunkSize} data bytes, file size ${file.size}`
        };
      } catch (err) {
        return { valid: false, error: err.message };
      }
    }

    async function stopRecording(timestamps = []) {
      const st = recordingState;
      if (!st || !st.active) return null;
      st.active = false;
      machineState = "finalizing";
      clearInterval(headerSyncTimer);
      headerSyncTimer = null;

      const sampleDuration = st.sampleRate > 0 && st.totalFrames > 0
        ? Math.round(st.totalFrames / st.sampleRate)
        : 0;
      const durationSeconds = Math.max(1, sampleDuration || Math.round((Date.now() - st.startedAt) / 1000));

      if (st.worker) {
        await new Promise((resolve) => {
          st.flushResolver = resolve;
          st.worker.postMessage({ type: "flush" });
          setTimeout(resolve, 1500);
        });
        try {
          st.worker.terminate();
        } catch (_) { }
        st.worker = null;
      }

      await writeChain;

      if (st.ch1Writable) {
        await writeHeaderAtStart(st.ch1Writable, st.sampleRate, st.bitDepth, st.dryCh1Bytes);
        await st.ch1Writable.close();
      }
      if (st.ch2Writable) {
        await writeHeaderAtStart(st.ch2Writable, st.sampleRate, st.bitDepth, st.dryCh2Bytes);
        await st.ch2Writable.close();
      }
      if (st.masterWritable) {
        await st.masterWritable.close();
      }

      if ((activeSessionDirHandle || selectedDirHandle) && Array.isArray(timestamps) && timestamps.length > 0) {
        await writeFileInSessionDir(
          `${st.sessionDate}_Audition_Markers.csv`,
          WavUtils.formatAuditionMarkersCsv(timestamps)
        );
      }

      let dryCh1File = null;
      if (st.ch1FileHandle) {
        try { dryCh1File = await st.ch1FileHandle.getFile(); } catch (_) { }
      } else if (st.fallbackCh1Chunks.length > 0) {
        const h1 = WavUtils.buildWavHeader({
          sampleRate: st.sampleRate, numChannels: 1, bitDepth: st.bitDepth, dataByteLength: st.dryCh1Bytes
        });
        dryCh1File = makeFileBlob([h1, ...st.fallbackCh1Chunks], st.ch1Filename, "audio/wav");
      }

      let dryCh2File = null;
      if (st.ch2FileHandle) {
        try { dryCh2File = await st.ch2FileHandle.getFile(); } catch (_) { }
      } else if (st.fallbackCh2Chunks.length > 0) {
        const h2 = WavUtils.buildWavHeader({
          sampleRate: st.sampleRate, numChannels: 1, bitDepth: st.bitDepth, dataByteLength: st.dryCh2Bytes
        });
        dryCh2File = makeFileBlob([h2, ...st.fallbackCh2Chunks], st.ch2Filename, "audio/wav");
      }

      let masterFile = null;
      if (st.masterFileHandle) {
        try { masterFile = await st.masterFileHandle.getFile(); } catch (_) { }
      } else if (st.fallbackMasterChunks.length > 0) {
        masterFile = makeFileBlob(st.fallbackMasterChunks, st.masterFilename, "audio/mpeg");
      }

      const v1 = dryCh1File ? await verifyStemFile(dryCh1File) : { valid: !st.recordDryCh1 };
      const v2 = dryCh2File ? await verifyStemFile(dryCh2File) : { valid: !st.recordDryCh2 };
      const verified = Boolean(v1.valid && v2.valid && (st.writeErrorCount || 0) === 0);
      machineState = verified ? "verified" : "error";

      const sessionManifest = {
        schemaVersion: "2.0",
        projectUid: st.sessionUid,
        sessionDate: st.sessionDate,
        storageBackend: st.storageBackend,
        sampleRate: st.sampleRate,
        bitDepth: st.bitDepth,
        publishBitrateKbps: st.publishBitrateKbps,
        hardwareCaptureFormat: st.hardwareCaptureFormat || null,
        totalFrames: st.totalFrames,
        ch1Samples: st.ch1Samples || 0,
        ch2Samples: st.ch2Samples || 0,
        sampleSyncDriftFrames: Math.abs((st.ch1Samples || 0) - (st.ch2Samples || 0)),
        durationSeconds,
        localFiles: {
          ch1Dry: dryCh1File ? dryCh1File.name : null,
          ch2Dry: dryCh2File ? dryCh2File.name : null,
          liveReferenceMp3: masterFile ? masterFile.name : null
        },
        timestamps,
        verification: { ch1: v1, ch2: v2, verified },
        savedAt: new Date().toISOString()
      };
      if (activeSessionDirHandle || selectedDirHandle) {
        await writeFileInSessionDir("project.json", JSON.stringify(sessionManifest, null, 2));
      }

      try {
        if (window.localStorage) {
          window.localStorage.setItem(RECOVERY_META_KEY, JSON.stringify({
            sessionUid: st.sessionUid,
            sessionDate: st.sessionDate,
            storageBackend: st.storageBackend,
            active: false,
            verified
          }));
        }
      } catch (_) { }

      const fallbackDownloads = [];
      if (st.storageBackend !== "user_folder") {
        if (dryCh1File) {
          fallbackDownloads.push({
            label: "Ch 1 Vocals Dry WAV",
            filename: `${st.sessionDate}_Ch1_Vocals_DRY.wav`,
            blob: dryCh1File
          });
        }
        if (dryCh2File) {
          fallbackDownloads.push({
            label: "Ch 2 Instruments Dry WAV",
            filename: `${st.sessionDate}_Ch2_Instruments_DRY.wav`,
            blob: dryCh2File
          });
        }
        if (masterFile) {
          fallbackDownloads.push({
            label: `Live Reference (${st.publishBitrateKbps} kbps MP3)`,
            filename: `${st.sessionDate}_Live_Reference_${st.publishBitrateKbps}k.mp3`,
            blob: masterFile
          });
        }
      }

      const folderPrefix = selectedDirHandle
        ? (String(selectedDirHandle.name || "").trim().toLowerCase() === "bhajanplanner"
          ? selectedDirHandle.name
          : `${selectedDirHandle.name}/BhajanPlanner`)
        : null;

      const result = {
        sessionUid: st.sessionUid,
        projectUid: st.sessionUid,
        sessionDate: st.sessionDate,
        sampleRate: st.sampleRate,
        bitDepth: st.bitDepth,
        durationSeconds,
        sampleFrames: st.totalFrames,
        sampleSyncDriftFrames: Math.abs((st.ch1Samples || 0) - (st.ch2Samples || 0)),
        hardwareCaptureFormat: st.hardwareCaptureFormat || null,
        dryCh1Bytes: st.dryCh1Bytes,
        dryCh2Bytes: st.dryCh2Bytes,
        masterBytes: st.masterBytes,
        dryCh1File,
        dryCh2File,
        masterFile,
        verified,
        verification: { ch1: v1, ch2: v2 },
        storageBackend: st.storageBackend,
        savedToDefaultVault: st.storageBackend === "opfs_vault",
        vaultPath: st.storageBackend === "opfs_vault"
          ? `BhajanPlanner/Recordings/${st.sessionDate}/${st.sessionUid}`
          : null,
        savedToFolder: folderPrefix ? `${folderPrefix}/Recordings/${st.sessionDate}/${st.sessionUid}` : null,
        fallbackDownloads
      };

      recordingState = null;
      return result;
    }

    async function computeSha256Hex(file) {
      try {
        if (!file || !window.crypto || !window.crypto.subtle) return null;
        const buf = await file.arrayBuffer();
        const digest = await window.crypto.subtle.digest("SHA-256", buf);
        return Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } catch (_) {
        return null;
      }
    }

    const UPLOAD_BLOB_DB = "bp_studio_uploads_v1";
    const UPLOAD_BLOB_STORE = "upload_blobs";

    function buildStructuredR2Key(sessionDate, sessionUid, artifactName = "final-master.mp3") {
      const cleanDate = /^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || "").trim())
        ? String(sessionDate).trim()
        : new Date().toISOString().slice(0, 10);
      const cleanUid = String(sessionUid || `session-${cleanDate}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || `session-${cleanDate}`;
      const cleanArtifact = String(artifactName || "final-master.mp3")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100) || "final-master.mp3";
      return `recordings/${cleanDate}/${cleanUid}/${cleanArtifact}`;
    }

    function openQueueDb() {
      return new Promise((resolve, reject) => {
        if (typeof window === "undefined" || !window.indexedDB) {
          reject(new Error("IndexedDB unavailable"));
          return;
        }
        const req = window.indexedDB.open(UPLOAD_BLOB_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(UPLOAD_BLOB_STORE)) {
            db.createObjectStore(UPLOAD_BLOB_STORE, { keyPath: "storageKey" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
      });
    }

    async function saveQueuedBlob(storageKey, file, meta) {
      if (!storageKey || !file || typeof window === "undefined" || !window.indexedDB) return;
      try {
        const db = await openQueueDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(UPLOAD_BLOB_STORE, "readwrite");
          tx.objectStore(UPLOAD_BLOB_STORE).put({
            storageKey,
            blob: file,
            filename: file.name || meta?.filename || "recording.mp3",
            contentType: file.type || "audio/mpeg",
            meta: meta || {},
            updatedAt: new Date().toISOString()
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      } catch (_) { }
    }

    async function loadQueuedBlob(storageKey) {
      if (!storageKey || typeof window === "undefined" || !window.indexedDB) return null;
      try {
        const db = await openQueueDb();
        const rec = await new Promise((resolve, reject) => {
          const tx = db.transaction(UPLOAD_BLOB_STORE, "readonly");
          const req = tx.objectStore(UPLOAD_BLOB_STORE).get(storageKey);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
        db.close();
        return rec;
      } catch (_) {
        return null;
      }
    }

    async function deleteQueuedBlob(storageKey) {
      if (!storageKey || typeof window === "undefined" || !window.indexedDB) return;
      try {
        const db = await openQueueDb();
        await new Promise((resolve) => {
          const tx = db.transaction(UPLOAD_BLOB_STORE, "readwrite");
          tx.objectStore(UPLOAD_BLOB_STORE).delete(storageKey);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
        db.close();
      } catch (_) { }
    }

    function getPendingUploads() {
      try {
        return JSON.parse(window.localStorage.getItem(PENDING_QUEUE_KEY) || "[]");
      } catch (_) {
        return [];
      }
    }

    function queuePendingUpload(meta, file) {
      try {
        const list = getPendingUploads().filter((x) => x.storageKey !== meta.storageKey);
        list.push({ ...meta, queuedAt: new Date().toISOString() });
        window.localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(list));
        if (file) {
          saveQueuedBlob(meta.storageKey, file, meta);
        }
      } catch (_) { }
    }

    function removePendingUpload(storageKey) {
      try {
        const list = getPendingUploads().filter((x) => x.storageKey !== storageKey);
        window.localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(list));
        deleteQueuedBlob(storageKey);
      } catch (_) { }
    }

    async function uploadChunkWithRetry(url, buffer, csrfToken, attempts = 3) {
      let lastErr;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-CSRF-Token": csrfToken
            },
            body: buffer
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || `Part upload failed (${res.status})`);
          }
          return data;
        } catch (err) {
          lastErr = err;
          if (attempt < attempts) {
            await new Promise((r) => setTimeout(r, attempt * 800));
          }
        }
      }
      throw lastErr;
    }

    async function tryDirectPresignedPut(presignUrl, bodyBytes, contentType) {
      const res = await fetch(presignUrl, {
        method: "PUT",
        mode: "cors",
        headers: contentType ? { "Content-Type": contentType } : {},
        body: bodyBytes
      });
      if (!res.ok) {
        throw new Error(`Direct R2 PUT rejected (${res.status})`);
      }
      return res.headers.get("ETag") || res.headers.get("etag") || "";
    }

    async function uploadAuxObjectToR2({
      body,
      contentType = "application/json",
      sessionDate,
      sessionUid,
      storageKey,
      csrfToken,
      onProgress
    }) {
      const blob = body instanceof Blob
        ? body
        : new Blob([typeof body === "string" ? body : JSON.stringify(body, null, 2)], { type: contentType });
      const resolvedKey = storageKey || buildStructuredR2Key(sessionDate, sessionUid, "project.json");
      const isSingle = blob.size <= SINGLE_PUT_LIMIT_BYTES;
      const emit = (info) => {
        if (typeof onProgress === "function") onProgress(info);
      };

      if (isSingle) {
        try {
          const psRes = await fetch("/api/admin/live-stream/r2/presign", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
            body: JSON.stringify({ key: resolvedKey, session_date: sessionDate, session_id: sessionUid })
          });
          const psData = await psRes.json();
          if (psRes.ok && psData.success && psData.url) {
            const buf = await blob.arrayBuffer();
            await tryDirectPresignedPut(psData.url, buf, contentType);
            return { key: psData.key, publicUrl: psData.publicUrl, directToR2: true };
          }
        } catch (_) { }
      }

      const initRes = await fetch("/api/admin/live-stream/r2/upload-init", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({
          key: resolvedKey,
          session_date: sessionDate,
          content_type: contentType,
          single_part: isSingle
        })
      });
      const initData = await initRes.json();
      if (!initRes.ok || !initData.success) {
        throw new Error(initData.error || "Could not initialize auxiliary R2 upload.");
      }

      const cleanKey = initData.key;
      const uploadId = initData.uploadId || "";

      if (initData.mode === "single") {
        const buf = await blob.arrayBuffer();
        const partUrl = `/api/admin/live-stream/r2/upload-part?mode=single&key=${encodeURIComponent(cleanKey)}&contentType=${encodeURIComponent(contentType)}`;
        const upRes = await uploadChunkWithRetry(partUrl, buf, csrfToken);
        return { key: cleanKey, publicUrl: upRes.publicUrl, directToR2: false };
      }

      const totalParts = Math.ceil(blob.size / CHUNK_SIZE_BYTES);
      const completedParts = [];
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const start = (partNumber - 1) * CHUNK_SIZE_BYTES;
        const end = Math.min(blob.size, start + CHUNK_SIZE_BYTES);
        const buf = await blob.slice(start, end).arrayBuffer();
        emit({
          stage: "uploading_aux",
          pct: Math.round((partNumber / totalParts) * 100),
          message: `Uploading ${cleanKey.split("/").pop()} chunk ${partNumber}/${totalParts}...`
        });

        let partEtag = "";
        try {
          const psPartRes = await fetch("/api/admin/live-stream/r2/presign", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
            body: JSON.stringify({ key: cleanKey, session_date: sessionDate, uploadId, partNumber })
          });
          const psPart = await psPartRes.json();
          if (psPartRes.ok && psPart.success && psPart.url) {
            partEtag = await tryDirectPresignedPut(psPart.url, buf, "application/octet-stream");
          }
        } catch (_) {
          partEtag = "";
        }
        if (!partEtag) {
          const partUrl = `/api/admin/live-stream/r2/upload-part?mode=multipart&key=${encodeURIComponent(cleanKey)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
          const partData = await uploadChunkWithRetry(partUrl, buf, csrfToken);
          partEtag = partData.etag;
        }
        completedParts.push({ PartNumber: partNumber, ETag: partEtag });
      }

      const compRes = await fetch("/api/admin/live-stream/r2/upload-complete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ key: cleanKey, uploadId, parts: completedParts })
      });
      const compData = await compRes.json();
      if (!compRes.ok || !compData.success) {
        throw new Error(compData.error || "Failed to finalize multipart auxiliary upload.");
      }
      return { key: cleanKey, publicUrl: compData.publicUrl, directToR2: false };
    }

    async function uploadFileToR2AndPublish({
      file,
      sessionDate,
      sessionUid,
      title,
      storageKey,
      durationSeconds,
      timestamps = [],
      isPublished = true,
      notifyDevotees = true,
      artifactRole = "final_master",
      projectManifest = null,
      r2Keys = null,
      csrfToken,
      onProgress
    }) {
      if (!file) throw new Error("No audio file selected to upload.");

      const emit = (info) => {
        if (typeof onProgress === "function") onProgress(info);
      };

      const defaultArtifact = artifactRole === "live_ref"
        ? "live-ref.mp3"
        : (file.name && file.name.toLowerCase().endsWith(".wav") ? "final-master.wav" : "final-master.mp3");
      const targetStorageKey = storageKey || buildStructuredR2Key(sessionDate, sessionUid, defaultArtifact);

      const queuePayload = {
        sessionDate,
        sessionUid,
        title,
        storageKey: targetStorageKey,
        durationSeconds,
        timestamps,
        isPublished,
        notifyDevotees,
        artifactRole,
        projectManifest,
        r2Keys,
        filename: file.name,
        size: file.size
      };

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        queuePendingUpload(queuePayload, file);
        throw new Error("Offline: audio blob cached locally in IndexedDB. Reconnect internet and click Retry Queued Uploads.");
      }

      const checksumSha256 = await computeSha256Hex(file);
      const contentType = file.type || (file.name.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg");
      const isSingle = file.size <= SINGLE_PUT_LIMIT_BYTES;
      emit({ stage: "initializing", pct: 4, message: "Requesting secure Cloudflare R2 upload authorization..." });

      let finalUrl = "";
      let cleanKey = targetStorageKey;
      let directToR2Used = false;

      // 1. Attempt zero-relay Direct-to-R2 SigV4 Presigned PUT for single-part files <= 8 MB
      if (isSingle) {
        try {
          const psRes = await fetch("/api/admin/live-stream/r2/presign", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
            body: JSON.stringify({ key: targetStorageKey, session_date: sessionDate, session_id: sessionUid })
          });
          const psData = await psRes.json();
          if (psRes.ok && psData.success && psData.url) {
            emit({ stage: "uploading", pct: 35, message: "Uploading directly from laptop to Cloudflare R2 (0 MB relay)..." });
            const buf = await file.arrayBuffer();
            await tryDirectPresignedPut(psData.url, buf, contentType);
            cleanKey = psData.key;
            finalUrl = psData.publicUrl;
            directToR2Used = true;
          }
        } catch (_) {
          directToR2Used = false;
        }
      }

      // 2. Multipart / CORS Fallback through authorized endpoint if single presigned PUT didn't complete
      if (!directToR2Used) {
        let uploadId = "";
        try {
          const initRes = await fetch("/api/admin/live-stream/r2/upload-init", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
            body: JSON.stringify({
              key: targetStorageKey,
              session_date: sessionDate,
              content_type: contentType,
              single_part: isSingle
            })
          });
          const initData = await initRes.json();
          if (!initRes.ok || !initData.success) {
            throw new Error(initData.error || "Could not start Cloudflare R2 upload.");
          }

          cleanKey = initData.key;
          uploadId = initData.uploadId || "";

          if (initData.mode === "single") {
            emit({ stage: "uploading", pct: 35, message: "Uploading audio to Cloudflare R2..." });
            const buf = await file.arrayBuffer();
            const partUrl = `/api/admin/live-stream/r2/upload-part?mode=single&key=${encodeURIComponent(cleanKey)}&contentType=${encodeURIComponent(contentType)}`;
            const upRes = await uploadChunkWithRetry(partUrl, buf, csrfToken);
            finalUrl = upRes.publicUrl;
          } else {
            const totalParts = Math.ceil(file.size / CHUNK_SIZE_BYTES);
            const completedParts = [];
            for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
              const start = (partNumber - 1) * CHUNK_SIZE_BYTES;
              const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
              const buf = await file.slice(start, end).arrayBuffer();
              const pct = Math.min(92, Math.round((partNumber / totalParts) * 90));
              emit({
                stage: "uploading",
                pct: Math.max(8, Math.round(((partNumber - 1) / totalParts) * 90)),
                message: `Uploading chunk ${partNumber} of ${totalParts} to Cloudflare R2...`
              });

              let partEtag = "";
              try {
                const psPartRes = await fetch("/api/admin/live-stream/r2/presign", {
                  method: "POST",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
                  body: JSON.stringify({ key: cleanKey, session_date: sessionDate, uploadId, partNumber })
                });
                const psPart = await psPartRes.json();
                if (psPartRes.ok && psPart.success && psPart.url) {
                  partEtag = await tryDirectPresignedPut(psPart.url, buf, "application/octet-stream");
                }
              } catch (_) {
                partEtag = "";
              }

              if (!partEtag) {
                const partUrl = `/api/admin/live-stream/r2/upload-part?mode=multipart&key=${encodeURIComponent(cleanKey)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
                const partData = await uploadChunkWithRetry(partUrl, buf, csrfToken);
                partEtag = partData.etag;
              } else {
                directToR2Used = true;
              }

              completedParts.push({ PartNumber: partNumber, ETag: partEtag });
              emit({
                stage: "uploading",
                pct,
                message: `Uploaded chunk ${partNumber} of ${totalParts} (${pct}%)`
              });
            }

            emit({ stage: "completing", pct: 94, message: "Finalizing multipart upload in Cloudflare R2..." });
            const compRes = await fetch("/api/admin/live-stream/r2/upload-complete", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
              body: JSON.stringify({ key: cleanKey, uploadId, parts: completedParts })
            });
            const compData = await compRes.json();
            if (!compRes.ok || !compData.success) {
              throw new Error(compData.error || "Failed to finalize Cloudflare R2 multipart upload.");
            }
            finalUrl = compData.publicUrl;
          }
        } catch (err) {
          if (uploadId) {
            fetch("/api/admin/live-stream/r2/upload-abort", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
              body: JSON.stringify({ key: cleanKey, uploadId })
            }).catch(() => { });
          }
          queuePendingUpload({ ...queuePayload, storageKey: cleanKey }, file);
          throw err;
        }
      }

      const mergedR2Keys = Object.assign({}, r2Keys || {});
      if (projectManifest && typeof projectManifest === "object") {
        try {
          emit({ stage: "publishing", pct: 96, message: "Syncing project.json manifest to Cloudflare R2..." });
          const manifestRes = await uploadAuxObjectToR2({
            body: JSON.stringify(projectManifest, null, 2),
            contentType: "application/json",
            sessionDate,
            sessionUid,
            storageKey: buildStructuredR2Key(sessionDate, sessionUid, "project.json"),
            csrfToken
          });
          if (manifestRes?.key) mergedR2Keys.project_json_key = manifestRes.key;
        } catch (_) { }
      }

      emit({ stage: "publishing", pct: 98, message: "Linking SessionAudio & synchronized bhajan timestamps..." });
      let pubData;
      try {
        const pubRes = await fetch("/api/admin/live-stream/r2/publish", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({
            session_date: sessionDate,
            project_uid: sessionUid || null,
            title,
            storage_key: cleanKey,
            audio_url: finalUrl,
            duration_seconds: durationSeconds,
            file_size_bytes: file.size,
            checksum_sha256: checksumSha256,
            is_published: isPublished,
            notify_devotees: notifyDevotees,
            artifact_role: artifactRole,
            r2_keys: mergedR2Keys,
            timestamps
          })
        });
        pubData = await pubRes.json();
        if (!pubRes.ok || !pubData.success) {
          throw new Error(pubData.error || "Uploaded to R2, but failed to publish session audio.");
        }
      } catch (err) {
        queuePendingUpload({ ...queuePayload, storageKey: cleanKey }, file);
        throw err;
      }

      removePendingUpload(cleanKey);
      removePendingUpload(targetStorageKey);
      emit({
        stage: "done",
        pct: 100,
        message: directToR2Used
          ? "Uploaded Direct-to-R2 & published to Bhajan Planner!"
          : "Uploaded to Cloudflare R2 & published to Bhajan Planner!",
        directToR2: directToR2Used
      });
      return pubData;
    }

    async function retryPendingUploads({ csrfToken, onProgress } = {}) {
      const queue = getPendingUploads();
      const results = [];
      for (const item of queue) {
        const stored = await loadQueuedBlob(item.storageKey);
        if (!stored || !stored.blob) {
          results.push({ storageKey: item.storageKey, skipped: true, reason: "Blob missing (pick file manually)" });
          continue;
        }
        try {
          const fileObj = stored.blob instanceof File
            ? stored.blob
            : new File([stored.blob], stored.filename || item.filename || "recording.mp3", {
              type: stored.contentType || "audio/mpeg"
            });
          const pubRes = await uploadFileToR2AndPublish({
            file: fileObj,
            sessionDate: item.sessionDate,
            sessionUid: item.sessionUid,
            title: item.title,
            storageKey: item.storageKey,
            durationSeconds: item.durationSeconds || 0,
            timestamps: item.timestamps || [],
            isPublished: item.isPublished !== false,
            notifyDevotees: Boolean(item.notifyDevotees),
            artifactRole: item.artifactRole || "final_master",
            projectManifest: item.projectManifest || null,
            r2Keys: item.r2Keys || null,
            csrfToken,
            onProgress
          });
          results.push({ storageKey: item.storageKey, success: true, response: pubRes });
        } catch (err) {
          results.push({ storageKey: item.storageKey, success: false, error: err.message });
        }
      }
      return results;
    }

    async function backupDryStemsToR2({ files = [], sessionDate, sessionUid, csrfToken, onProgress } = {}) {
      const uploaded = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f) continue;
        const roleName = f.name && f.name.trim()
          ? f.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
          : `stem-${i + 1}.wav`;
        const key = buildStructuredR2Key(sessionDate, sessionUid, roleName);
        const res = await uploadAuxObjectToR2({
          body: f,
          contentType: f.type || "audio/wav",
          sessionDate,
          sessionUid,
          storageKey: key,
          csrfToken,
          onProgress
        });
        uploaded.push({ name: f.name, key: res.key, publicUrl: res.publicUrl, size: f.size });
      }
      return uploaded;
    }

    async function repairWavFileIfNeeded(dirHandle, filename, fallbackSampleRate = 48000, fallbackBitDepth = 24) {
      if (!dirHandle || typeof dirHandle.getFileHandle !== "function") return null;
      let fh;
      let file;
      try {
        fh = await dirHandle.getFileHandle(filename, { create: false });
        file = await fh.getFile();
      } catch (_) {
        return null;
      }
      if (!file || file.size <= 44) return null;

      try {
        const headBuf = await file.slice(0, 44).arrayBuffer();
        const view = new DataView(headBuf);
        const riffOk =
          view.getUint8(0) === 82 && view.getUint8(1) === 73 && view.getUint8(2) === 70 && view.getUint8(3) === 70 &&
          view.getUint8(8) === 87 && view.getUint8(9) === 65 && view.getUint8(10) === 86 && view.getUint8(11) === 69;
        const fmtChannels = riffOk ? (view.getUint16(22, true) || 1) : 1;
        const fmtSampleRate = riffOk ? (view.getUint32(24, true) || fallbackSampleRate) : fallbackSampleRate;
        const fmtBits = riffOk ? (view.getUint16(34, true) || fallbackBitDepth) : fallbackBitDepth;
        const declaredDataBytes = riffOk ? view.getUint32(40, true) : 0;
        const actualDataBytes = Math.max(0, file.size - 44);

        if (!riffOk || declaredDataBytes !== actualDataBytes) {
          const repairedHeader = WavUtils.buildWavHeader({
            sampleRate: fmtSampleRate,
            numChannels: fmtChannels,
            bitDepth: fmtBits,
            dataByteLength: actualDataBytes
          });
          if (typeof fh.createWritable === "function") {
            const wr = await fh.createWritable({ keepExistingData: true });
            await wr.write({ type: "write", position: 0, data: repairedHeader });
            await wr.close();
            return await fh.getFile();
          }
          const pcmTail = file.slice(44);
          return makeFileBlob([repairedHeader, pcmTail], filename, "audio/wav");
        }
        return file;
      } catch (_) {
        return file;
      }
    }

    async function readVaultJsonSafe(dirHandle, filename) {
      try {
        const fh = await dirHandle.getFileHandle(filename, { create: false });
        const file = await fh.getFile();
        return JSON.parse(await file.text());
      } catch (_) {
        return null;
      }
    }

    async function getVaultFileSize(dirHandle, filename) {
      try {
        const fh = await dirHandle.getFileHandle(filename, { create: false });
        const f = await fh.getFile();
        return f ? f.size : 0;
      } catch (_) {
        return 0;
      }
    }

    async function iterDirEntries(dirHandle) {
      const out = [];
      if (!dirHandle) return out;
      if (typeof dirHandle.entries === "function") {
        for await (const pair of dirHandle.entries()) {
          out.push(pair);
        }
      } else if (typeof dirHandle.values === "function") {
        for await (const handle of dirHandle.values()) {
          out.push([handle.name, handle]);
        }
      }
      return out;
    }

    async function getRecordingsDirFromRoot(rootHandle) {
      if (!rootHandle || typeof rootHandle.getDirectoryHandle !== "function") return null;
      try {
        const rootLower = String(rootHandle.name || "").trim().toLowerCase();
        const baseDir = rootLower === "bhajanplanner"
          ? rootHandle
          : await rootHandle.getDirectoryHandle("BhajanPlanner", { create: false });
        return await baseDir.getDirectoryHandle("Recordings", { create: false });
      } catch (_) {
        return null;
      }
    }

    async function listVaultSessions(overrideRoot) {
      const root = await getDefaultOpfsRoot(overrideRoot);
      const recDir = await getRecordingsDirFromRoot(root);
      if (!recDir) return [];

      const sessions = [];
      const dateEntries = await iterDirEntries(recDir);
      for (const [dateName, dateHandle] of dateEntries) {
        if (!dateHandle || dateHandle.kind !== "directory") continue;
        const sessEntries = await iterDirEntries(dateHandle);
        for (const [uidName, sessHandle] of sessEntries) {
          if (!sessHandle || sessHandle.kind !== "directory") continue;
          const manifest =
            (await readVaultJsonSafe(sessHandle, "project.json")) ||
            (await readVaultJsonSafe(sessHandle, "project.checkpoint.json")) ||
            {};
          const ch1Size = await getVaultFileSize(sessHandle, "Ch1_Vocals_DRY.wav");
          const ch2Size = await getVaultFileSize(sessHandle, "Ch2_Instruments_DRY.wav");
          const masterSize = await getVaultFileSize(sessHandle, "Live_Reference.mp3");
          const totalBytes = ch1Size + ch2Size + masterSize;
          if (totalBytes <= 44) continue;

          const sr = Number(manifest.sampleRate) || 48000;
          const bits = Number(manifest.bitDepth) || 24;
          const maxDataBytes = Math.max(0, Math.max(ch1Size, ch2Size) - 44);
          const estDurationSec =
            Number(manifest.durationSeconds) ||
            (maxDataBytes > 0 ? Math.max(1, Math.round(maxDataBytes / (sr * (bits / 8)))) : 0);

          sessions.push({
            sessionDate: manifest.sessionDate || dateName,
            sessionUid: manifest.projectUid || manifest.sessionUid || uidName,
            dirNameDate: dateName,
            dirNameUid: uidName,
            totalBytes,
            ch1Bytes: ch1Size,
            ch2Bytes: ch2Size,
            masterBytes: masterSize,
            hasCh1: ch1Size > 44,
            hasCh2: ch2Size > 44,
            hasMaster: masterSize > 0,
            durationSeconds: estDurationSec,
            sampleRate: sr,
            bitDepth: bits,
            timestamps: Array.isArray(manifest.timestamps) ? manifest.timestamps : [],
            savedAt: manifest.savedAt || null
          });
        }
      }

      sessions.sort((a, b) => {
        const ta = a.savedAt ? Date.parse(a.savedAt) : 0;
        const tb = b.savedAt ? Date.parse(b.savedAt) : 0;
        if (tb !== ta) return tb - ta;
        return String(b.sessionUid).localeCompare(String(a.sessionUid));
      });
      return sessions;
    }

    async function loadVaultSession(sessionDate, sessionUid, overrideRoot) {
      const root = await getDefaultOpfsRoot(overrideRoot);
      const recDir = await getRecordingsDirFromRoot(root);
      if (!recDir) throw new Error("No recordings directory found in Default SSD Vault.");

      const dateDir = await recDir.getDirectoryHandle(sessionDate, { create: false });
      const sessDir = await dateDir.getDirectoryHandle(sessionUid, { create: false });
      activeSessionDirHandle = sessDir;
      lastSessionUid = sessionUid;

      const manifest =
        (await readVaultJsonSafe(sessDir, "project.json")) ||
        (await readVaultJsonSafe(sessDir, "project.checkpoint.json")) ||
        {};
      const sampleRate = Number(manifest.sampleRate) || 48000;
      const bitDepth = Number(manifest.bitDepth) || 24;
      const kbps = Number(manifest.publishBitrateKbps) || 192;

      const dryCh1File = await repairWavFileIfNeeded(sessDir, "Ch1_Vocals_DRY.wav", sampleRate, bitDepth);
      const dryCh2File = await repairWavFileIfNeeded(sessDir, "Ch2_Instruments_DRY.wav", sampleRate, bitDepth);

      let masterFile = null;
      try {
        const mfh = await sessDir.getFileHandle("Live_Reference.mp3", { create: false });
        const mf = await mfh.getFile();
        if (mf && mf.size > 0) masterFile = mf;
      } catch (_) { }

      const ch1Bytes = dryCh1File ? Math.max(0, dryCh1File.size - 44) : 0;
      const ch2Bytes = dryCh2File ? Math.max(0, dryCh2File.size - 44) : 0;
      const maxDataBytes = Math.max(ch1Bytes, ch2Bytes);
      const durationSeconds =
        Number(manifest.durationSeconds) ||
        (maxDataBytes > 0 ? Math.max(1, Math.round(maxDataBytes / (sampleRate * (bitDepth / 8)))) : 0);

      const fallbackDownloads = [];
      if (dryCh1File) {
        fallbackDownloads.push({
          label: "Ch 1 Vocals Dry WAV",
          filename: `${sessionDate}_Ch1_Vocals_DRY.wav`,
          blob: dryCh1File
        });
      }
      if (dryCh2File) {
        fallbackDownloads.push({
          label: "Ch 2 Instruments Dry WAV",
          filename: `${sessionDate}_Ch2_Instruments_DRY.wav`,
          blob: dryCh2File
        });
      }
      if (masterFile) {
        fallbackDownloads.push({
          label: `Live Reference (${kbps} kbps MP3)`,
          filename: `${sessionDate}_Live_Reference_${kbps}k.mp3`,
          blob: masterFile
        });
      }

      return {
        sessionUid,
        projectUid: sessionUid,
        sessionDate,
        sampleRate,
        bitDepth,
        durationSeconds,
        dryCh1Bytes: ch1Bytes,
        dryCh2Bytes: ch2Bytes,
        masterBytes: masterFile ? masterFile.size : 0,
        dryCh1File,
        dryCh2File,
        masterFile,
        timestamps: Array.isArray(manifest.timestamps) ? manifest.timestamps : [],
        storageBackend: "opfs_vault",
        savedToDefaultVault: true,
        recoveredFromVault: true,
        vaultPath: `BhajanPlanner/Recordings/${sessionDate}/${sessionUid}`,
        verified: Boolean(dryCh1File || dryCh2File || masterFile),
        fallbackDownloads
      };
    }

    async function deleteVaultSession(sessionDate, sessionUid, overrideRoot) {
      const root = await getDefaultOpfsRoot(overrideRoot);
      const recDir = await getRecordingsDirFromRoot(root);
      if (!recDir) return false;
      try {
        const dateDir = await recDir.getDirectoryHandle(sessionDate, { create: false });
        await dateDir.removeEntry(sessionUid, { recursive: true });
        try {
          const remaining = await iterDirEntries(dateDir);
          if (remaining.length === 0) {
            await recDir.removeEntry(sessionDate, { recursive: false });
          }
        } catch (_) { }
        return true;
      } catch (_) {
        return false;
      }
    }

    return {
      isFileSystemApiSupported,
      isOpfsVaultSupported,
      setTestOpfsRoot,
      pickDirectory,
      restoreSavedDirectory,
      getDirectoryName,
      getStorageSummary,
      getState,
      isRecording,
      getStats,
      getDiskEstimate,
      buildStructuredR2Key,
      writeFileInSessionDir,
      saveArtifactFile: writeFileInSessionDir,
      readFileFromSessionDir,
      saveWaveformCache,
      loadWaveformCache,
      getPendingUploads,
      computeSha256Hex,
      startRecording,
      pushDryPcm,
      pushMasterPcm,
      stopRecording,
      repairWavFileIfNeeded,
      listVaultSessions,
      loadVaultSession,
      deleteVaultSession,
      uploadAuxObjectToR2,
      uploadFileToR2AndPublish,
      retryPendingUploads,
      backupDryStemsToR2
    };
  });

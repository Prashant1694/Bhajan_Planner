/**
 * Multitrack Direct-to-SSD Recorder & Cloudflare R2 Multipart Publisher
 * Streams pre-FX 24-bit/48kHz WAV stems + post-FX Master MP3 straight to local SSD,
 * then uploads edited/recorded MP3s directly to Cloudflare R2 in resumable 8 MB chunks.
 */
(function (window) {
  "use strict";

  const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB multipart chunks (>= S3/R2 5 MB minimum)
  const SINGLE_PUT_LIMIT_BYTES = 5 * 1024 * 1024;
  const WavUtils = window.LiveStreamWavUtils;

  let selectedDirHandle = null;
  let recordingState = null;
  let writeChain = Promise.resolve();
  let headerSyncTimer = null;

  function enqueueWrite(task) {
    writeChain = writeChain.then(task).catch((err) => {
      console.error("[LiveRecorder] Disk write error:", err);
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
    return { ok: true, fallbackOnly: false, name: handle.name };
  }

  function getDirectoryName() {
    return selectedDirHandle ? selectedDirHandle.name : null;
  }

  function isRecording() {
    return Boolean(recordingState && recordingState.active);
  }

  function getStats() {
    if (!recordingState) {
      return {
        active: false,
        elapsedSeconds: 0,
        totalBytes: 0,
        dryCh1Bytes: 0,
        dryCh2Bytes: 0,
        masterBytes: 0
      };
    }
    return {
      active: recordingState.active,
      elapsedSeconds: recordingState.startedAt
        ? Math.max(0, Math.floor((Date.now() - recordingState.startedAt) / 1000))
        : 0,
      totalBytes:
        recordingState.dryCh1Bytes +
        recordingState.dryCh2Bytes +
        recordingState.masterBytes,
      dryCh1Bytes: recordingState.dryCh1Bytes,
      dryCh2Bytes: recordingState.dryCh2Bytes,
      masterBytes: recordingState.masterBytes
    };
  }

  async function startRecording(options = {}) {
    if (isRecording()) {
      throw new Error("Recording is already active.");
    }

    const sessionDate =
      options.sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(options.sessionDate)
        ? options.sessionDate
        : new Date().toISOString().slice(0, 10);
    const bitDepth = [16, 24, 32].includes(Number(options.bitDepth)) ? Number(options.bitDepth) : 24;
    const sampleRate = Number(options.sampleRate) || 48000;
    const publishBitrateKbps = Number(options.publishBitrateKbps) || 112;
    const recordDryCh1 = options.recordDryCh1 !== false;
    const recordDryCh2 = options.recordDryCh2 !== false;
    const recordMasterMp3 = options.recordMasterMp3 !== false;

    const st = {
      active: true,
      sessionDate,
      bitDepth,
      sampleRate,
      publishBitrateKbps,
      recordDryCh1,
      recordDryCh2,
      recordMasterMp3,
      startedAt: Date.now(),
      dryCh1Bytes: 0,
      dryCh2Bytes: 0,
      ch1WritePos: 44,
      ch2WritePos: 44,
      masterBytes: 0,
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

    if (selectedDirHandle) {
      if (recordDryCh1) {
        st.ch1FileHandle = await selectedDirHandle.getFileHandle(
          `${sessionDate}_Ch1_Instruments_DRY.wav`,
          { create: true }
        );
        st.ch1Writable = await st.ch1FileHandle.createWritable();
        await writeHeaderAtStart(st.ch1Writable, sampleRate, bitDepth, 0);
      }
      if (recordDryCh2) {
        st.ch2FileHandle = await selectedDirHandle.getFileHandle(
          `${sessionDate}_Ch2_Vocals_DRY.wav`,
          { create: true }
        );
        st.ch2Writable = await st.ch2FileHandle.createWritable();
        await writeHeaderAtStart(st.ch2Writable, sampleRate, bitDepth, 0);
      }
      if (recordMasterMp3) {
        st.masterFileHandle = await selectedDirHandle.getFileHandle(
          `${sessionDate}_Master_${publishBitrateKbps}k.mp3`,
          { create: true }
        );
        st.masterWritable = await st.masterFileHandle.createWritable();
      }
    }

    if (recordMasterMp3) {
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
    writeChain = Promise.resolve();

    clearInterval(headerSyncTimer);
    if (selectedDirHandle && (recordDryCh1 || recordDryCh2)) {
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
        });
      }, 15000);
    }

    return getStats();
  }

  function pushDryPcm(ch1Float, ch2Float) {
    const st = recordingState;
    if (!st || !st.active) return;

    if (st.recordDryCh1 && ch1Float && ch1Float.length > 0) {
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

  async function stopRecording(timestamps = []) {
    const st = recordingState;
    if (!st || !st.active) return null;
    st.active = false;
    clearInterval(headerSyncTimer);
    headerSyncTimer = null;

    const durationSeconds = Math.max(1, Math.round((Date.now() - st.startedAt) / 1000));

    if (st.worker) {
      await new Promise((resolve) => {
        st.flushResolver = resolve;
        st.worker.postMessage({ type: "flush" });
        setTimeout(resolve, 1500);
      });
      try {
        st.worker.terminate();
      } catch (_) {}
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

    if (selectedDirHandle && Array.isArray(timestamps) && timestamps.length > 0) {
      try {
        const csvHandle = await selectedDirHandle.getFileHandle(
          `${st.sessionDate}_Audition_Markers.csv`,
          { create: true }
        );
        const csvWriter = await csvHandle.createWritable();
        await csvWriter.write(WavUtils.formatAuditionMarkersCsv(timestamps));
        await csvWriter.close();
      } catch (err) {
        console.warn("[LiveRecorder] Could not write markers CSV:", err.message);
      }
    }

    let dryCh1File = null;
    if (st.ch1FileHandle) {
      try {
        dryCh1File = await st.ch1FileHandle.getFile();
      } catch (_) {}
    } else if (st.fallbackCh1Chunks.length > 0) {
      const h1 = WavUtils.buildWavHeader({
        sampleRate: st.sampleRate,
        numChannels: 1,
        bitDepth: st.bitDepth,
        dataByteLength: st.dryCh1Bytes
      });
      dryCh1File = new File(
        [h1, ...st.fallbackCh1Chunks],
        `${st.sessionDate}_Ch1_Instruments_DRY.wav`,
        { type: "audio/wav" }
      );
    }

    let dryCh2File = null;
    if (st.ch2FileHandle) {
      try {
        dryCh2File = await st.ch2FileHandle.getFile();
      } catch (_) {}
    } else if (st.fallbackCh2Chunks.length > 0) {
      const h2 = WavUtils.buildWavHeader({
        sampleRate: st.sampleRate,
        numChannels: 1,
        bitDepth: st.bitDepth,
        dataByteLength: st.dryCh2Bytes
      });
      dryCh2File = new File(
        [h2, ...st.fallbackCh2Chunks],
        `${st.sessionDate}_Ch2_Vocals_DRY.wav`,
        { type: "audio/wav" }
      );
    }

    let masterFile = null;
    if (st.masterFileHandle) {
      try {
        masterFile = await st.masterFileHandle.getFile();
      } catch (_) {}
    } else if (st.fallbackMasterChunks.length > 0) {
      masterFile = new File(
        st.fallbackMasterChunks,
        `${st.sessionDate}_Master_${st.publishBitrateKbps}k.mp3`,
        { type: "audio/mpeg" }
      );
    }

    const fallbackDownloads = [];
    if (!selectedDirHandle) {
      if (dryCh1File) {
        fallbackDownloads.push({
          label: "Ch 1 Instruments Dry WAV",
          filename: dryCh1File.name,
          blob: dryCh1File
        });
      }
      if (dryCh2File) {
        fallbackDownloads.push({
          label: "Ch 2 Vocals Dry WAV",
          filename: dryCh2File.name,
          blob: dryCh2File
        });
      }
      if (masterFile) {
        fallbackDownloads.push({
          label: `Master Processed (${st.publishBitrateKbps} kbps MP3)`,
          filename: masterFile.name,
          blob: masterFile
        });
      }
    }

    const result = {
      sessionDate: st.sessionDate,
      durationSeconds,
      dryCh1Bytes: st.dryCh1Bytes,
      dryCh2Bytes: st.dryCh2Bytes,
      masterBytes: st.masterBytes,
      dryCh1File,
      dryCh2File,
      masterFile,
      savedToFolder: selectedDirHandle ? selectedDirHandle.name : null,
      fallbackDownloads
    };

    recordingState = null;
    return result;
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

  async function uploadFileToR2AndPublish({
    file,
    sessionDate,
    title,
    storageKey,
    durationSeconds,
    timestamps = [],
    isPublished = true,
    notifyDevotees = true,
    csrfToken,
    onProgress
  }) {
    if (!file) throw new Error("No MP3 file selected to upload.");

    const emit = (info) => {
      if (typeof onProgress === "function") onProgress(info);
    };

    const isSingle = file.size <= SINGLE_PUT_LIMIT_BYTES;
    emit({ stage: "initializing", pct: 2, message: "Initializing Cloudflare R2 upload..." });

    const initRes = await fetch("/api/admin/live-stream/r2/upload-init", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        key: storageKey,
        session_date: sessionDate,
        content_type: file.type || "audio/mpeg",
        single_part: isSingle
      })
    });
    const initData = await initRes.json();
    if (!initRes.ok || !initData.success) {
      throw new Error(initData.error || "Could not start Cloudflare R2 upload.");
    }

    const cleanKey = initData.key;
    const uploadId = initData.uploadId || "";
    let finalUrl = "";

    try {
      if (initData.mode === "single") {
        emit({ stage: "uploading", pct: 35, message: "Uploading audio to Cloudflare R2..." });
        const buf = await file.arrayBuffer();
        const partUrl = `/api/admin/live-stream/r2/upload-part?mode=single&key=${encodeURIComponent(cleanKey)}`;
        const upRes = await uploadChunkWithRetry(partUrl, buf, csrfToken);
        finalUrl = upRes.publicUrl;
      } else {
        const totalParts = Math.ceil(file.size / CHUNK_SIZE_BYTES);
        const completedParts = [];
        for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
          const start = (partNumber - 1) * CHUNK_SIZE_BYTES;
          const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
          const slice = file.slice(start, end);
          const buf = await slice.arrayBuffer();
          const pct = Math.min(92, Math.round((partNumber / totalParts) * 90));
          emit({
            stage: "uploading",
            pct: Math.max(5, Math.round(((partNumber - 1) / totalParts) * 90)),
            message: `Uploading chunk ${partNumber} of ${totalParts} to Cloudflare R2...`
          });

          const partUrl = `/api/admin/live-stream/r2/upload-part?mode=multipart&key=${encodeURIComponent(cleanKey)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
          const partData = await uploadChunkWithRetry(partUrl, buf, csrfToken);
          completedParts.push({ PartNumber: partData.partNumber, ETag: partData.etag });
          emit({
            stage: "uploading",
            pct,
            message: `Uploaded chunk ${partNumber} of ${totalParts} (${pct}%)`
          });
        }

        emit({ stage: "completing", pct: 94, message: "Finalizing file in Cloudflare R2..." });
        const compRes = await fetch("/api/admin/live-stream/r2/upload-complete", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken
          },
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
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrfToken
          },
          body: JSON.stringify({ key: cleanKey, uploadId })
        }).catch(() => {});
      }
      throw err;
    }

    emit({ stage: "publishing", pct: 97, message: "Linking session audio & bhajan timestamps..." });
    const pubRes = await fetch("/api/admin/live-stream/r2/publish", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        session_date: sessionDate,
        title,
        storage_key: cleanKey,
        audio_url: finalUrl,
        duration_seconds: durationSeconds,
        file_size_bytes: file.size,
        is_published: isPublished,
        notify_devotees: notifyDevotees,
        timestamps
      })
    });
    const pubData = await pubRes.json();
    if (!pubRes.ok || !pubData.success) {
      throw new Error(pubData.error || "Uploaded to R2, but failed to publish session audio.");
    }

    emit({ stage: "done", pct: 100, message: "Uploaded to Cloudflare R2 & published to Bhajan Planner!" });
    return pubData;
  }

  window.LiveStudioRecorder = {
    isFileSystemApiSupported,
    pickDirectory,
    getDirectoryName,
    isRecording,
    getStats,
    startRecording,
    pushDryPcm,
    pushMasterPcm,
    stopRecording,
    uploadFileToR2AndPublish
  };
})(window);

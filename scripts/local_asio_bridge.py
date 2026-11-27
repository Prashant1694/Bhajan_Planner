"""
Bhajan Planner Local Native Audio Bridge (Zero-Cost Zero-Pip Companion)

Streams 2 routed audio buses (Ch1: Vocals, Ch2: Instruments) at 48 kHz Float32 PCM
over ws://127.0.0.1:17940 directly to the Bhajan Planner Live Studio browser tab
(`bp-asio-ingest` AudioWorklet), bypassing Windows Shared Mode 1-channel mono summing.

Capture backends (in automatic priority order):
  1. WASAPI Exclusive (`AUDCLNT_SHAREMODE_EXCLUSIVE` via ctypes COM):
     Acquires true discrete 2-ch+ hardware inputs (e.g. Behringer UMC / USB Audio CODEC)
     at the ADC's physical channel count even when Windows Sound Control Panel
     defaults Shared Mode to 1 channel, with ZERO third-party pip packages.
  2. Native 64-bit COM ASIO (`IASIO` via HKLM\\SOFTWARE\\ASIO):
     Connects directly to ASIO drivers (ASIO4ALL v2, Behringer USB ASIO, Soundcraft, etc.)
     when selected or matched to external USB pins.
  3. PortAudio `sounddevice` (when installed) or Windows WaveIn (`winmm`) fallback.
"""

import argparse
import asyncio
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import math
import os
import queue
import re
import signal
import struct
import subprocess
import sys
import threading
import time
import uuid

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17940
DEFAULT_RATE = 48000
DEFAULT_BLOCKSIZE = 512

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_SHAREMODE_EXCLUSIVE = 1
AUDCLNT_E_DEVICE_INVALIDATED = 0x88890004
AUDCLNT_E_DEVICE_IN_USE = 0x8889000A
AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED = 0x88890019


def clean_hardware_name(raw_name):
    """Extracts a concise OS device name without hardcoded vendor lists, stripping USB VID:PID tags."""
    txt = str(raw_name or "").strip()
    if not txt:
        return "Audio Interface"
    txt = re.sub(r"\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)", "", txt).strip()
    paren_match = re.search(r"\(([^()]+)\)?\s*$", txt)
    if paren_match:
        inner = paren_match.group(1).strip()
        inner = re.sub(r"^\d+\s*-\s*", "", inner).strip()
        if inner:
            return inner
    return re.sub(r"^\d+\s*-\s*", "", txt).strip()


def compute_raw_channel_levels(channel_arrays, frames):
    """Computes pre-routing physical peak/RMS dBFS, correlation and active pin indices."""
    if not channel_arrays or frames <= 0:
        return {"channels": 0, "peaksDb": [], "rmsDb": [], "activePins": [], "corr01": 0.0, "duplicatedMono": False}
    peaks_db = []
    rms_db = []
    active_pins = []
    for ch_idx, samples in enumerate(channel_arrays):
        n = min(int(frames), len(samples))
        if n <= 0:
            peaks_db.append(-96.0)
            rms_db.append(-96.0)
            continue
        peak = 0.0
        sum_sq = 0.0
        for i in range(n):
            v = samples[i]
            av = -v if v < 0.0 else v
            if av > peak:
                peak = av
            sum_sq += v * v
        rms = math.sqrt(sum_sq / n)
        p_db = round(20.0 * math.log10(peak), 1) if peak > 1e-5 else -96.0
        r_db = round(20.0 * math.log10(rms), 1) if rms > 1e-5 else -96.0
        peaks_db.append(p_db)
        rms_db.append(r_db)
        if p_db > -45.0:
            active_pins.append(ch_idx)
    corr01 = 0.0
    duplicated = False
    if len(channel_arrays) >= 2:
        n2 = min(int(frames), len(channel_arrays[0]), len(channel_arrays[1]))
        if n2 > 0:
            c0, c1 = channel_arrays[0], channel_arrays[1]
            dot = e0 = e1 = 0.0
            for i in range(n2):
                a, b = c0[i], c1[i]
                dot += a * b
                e0 += a * a
                e1 += b * b
            if e0 > 1e-9 and e1 > 1e-9:
                corr01 = round(dot / math.sqrt(e0 * e1), 3)
            duplicated = corr01 > 0.97 and abs(peaks_db[0] - peaks_db[1]) < 1.2 and peaks_db[0] > -55.0
    return {
        "channels": len(channel_arrays),
        "peaksDb": peaks_db,
        "rmsDb": rms_db,
        "activePins": active_pins,
        "corr01": corr01,
        "duplicatedMono": duplicated,
    }


class _RawPinLevelTracker:
    """Thread-safe adaptive noise-floor, SNR, correlation & transient peak/RMS tracker per physical pin."""

    def __init__(self, num_channels=2):
        self._lock = threading.Lock()
        n = max(0, int(num_channels or 0))
        self._channels = n
        self._peaks = [0.0] * n
        self._sum_sq = [0.0] * n
        self._counts = [0] * n
        self._floors_db = [None] * n
        self._dot01 = 0.0
        self._e0 = 0.0
        self._e1 = 0.0

    def reset(self, num_channels):
        with self._lock:
            n = max(0, int(num_channels or 0))
            self._channels = n
            self._peaks = [0.0] * n
            self._sum_sq = [0.0] * n
            self._counts = [0] * n
            self._floors_db = [None] * n
            self._dot01 = 0.0
            self._e0 = 0.0
            self._e1 = 0.0

    def update(self, channel_arrays, frames):
        if not channel_arrays or frames <= 0:
            return
        n_ch = len(channel_arrays)
        local_peaks = []
        local_sq = []
        local_n = []
        for ch_idx in range(n_ch):
            samples = channel_arrays[ch_idx]
            n = min(int(frames), len(samples))
            pk = 0.0
            sq = 0.0
            for i in range(n):
                v = samples[i]
                av = -v if v < 0.0 else v
                if av > pk:
                    pk = av
                sq += v * v
            local_peaks.append(pk)
            local_sq.append(sq)
            local_n.append(n)
        dot01 = e0 = e1 = 0.0
        if n_ch >= 2:
            n2 = min(int(frames), len(channel_arrays[0]), len(channel_arrays[1]))
            c0, c1 = channel_arrays[0], channel_arrays[1]
            for i in range(n2):
                a, b = c0[i], c1[i]
                dot01 += a * b
                e0 += a * a
                e1 += b * b
        with self._lock:
            if self._channels != n_ch:
                self._channels = n_ch
                self._peaks = [0.0] * n_ch
                self._sum_sq = [0.0] * n_ch
                self._counts = [0] * n_ch
                self._floors_db = [None] * n_ch
                self._dot01 = 0.0
                self._e0 = 0.0
                self._e1 = 0.0
            for c in range(n_ch):
                if local_peaks[c] > self._peaks[c]:
                    self._peaks[c] = local_peaks[c]
                self._sum_sq[c] += local_sq[c]
                self._counts[c] += local_n[c]
            self._dot01 += dot01
            self._e0 += e0
            self._e1 += e1

    def flush(self):
        with self._lock:
            n_ch = self._channels
            peaks_db = []
            rms_db = []
            floors_db = []
            snr_db_list = []
            active_pins = []
            for c in range(n_ch):
                pk = self._peaks[c]
                cnt = self._counts[c]
                rms = math.sqrt(self._sum_sq[c] / cnt) if cnt > 0 else 0.0
                p_db = round(20.0 * math.log10(pk), 1) if pk > 1e-5 else -96.0
                r_db = round(20.0 * math.log10(rms), 1) if rms > 1e-5 else -96.0
                if cnt > 0:
                    cur_fl = self._floors_db[c]
                    if cur_fl is None:
                        cur_fl = max(-90.0, min(-28.0, r_db if r_db > -92.0 else -72.0))
                    elif r_db < cur_fl:
                        cur_fl = cur_fl + 0.35 * (max(-90.0, r_db) - cur_fl)
                    elif (p_db - r_db) < 6.5 and r_db < -28.0:
                        cur_fl = cur_fl + 0.04 * (r_db - cur_fl)
                    cur_fl = max(-90.0, min(-28.0, cur_fl))
                    self._floors_db[c] = cur_fl
                floor_val = round(self._floors_db[c] if self._floors_db[c] is not None else -72.0, 1)
                snr_val = round(p_db - floor_val, 1)
                peaks_db.append(p_db)
                rms_db.append(r_db)
                floors_db.append(floor_val)
                snr_db_list.append(snr_val)
                if p_db > -45.0 and (snr_val >= 9.0 or p_db >= -24.0):
                    active_pins.append(c)
                self._peaks[c] = 0.0
                self._sum_sq[c] = 0.0
                self._counts[c] = 0
            corr01 = 0.0
            if n_ch >= 2 and self._e0 > 1e-9 and self._e1 > 1e-9:
                corr01 = round(self._dot01 / math.sqrt(self._e0 * self._e1), 3)
            self._dot01 = 0.0
            self._e0 = 0.0
            self._e1 = 0.0
            duplicated = (
                n_ch >= 2
                and corr01 > 0.97
                and abs(peaks_db[0] - peaks_db[1]) < 1.2
                and peaks_db[0] > -55.0
            )
            return {
                "channels": n_ch,
                "peaksDb": peaks_db,
                "rmsDb": rms_db,
                "noiseFloorsDb": floors_db,
                "snrDb": snr_db_list,
                "activePins": active_pins,
                "corr01": corr01,
                "duplicatedMono": duplicated,
            }


def build_audition_channel_catalog(clean_name, num_channels, pin_names=None):
    """Builds Audition-style [01M] Mono / [01S] Stereo channel options for a device."""
    safe_name = clean_hardware_name(clean_name)
    total = max(1, int(num_channels or 1))
    pins = list(pin_names) if pin_names else []
    catalog = []

    for ch in range(total):
        code = f"{ch + 1:02d}M"
        pin = str(pins[ch]).strip() if ch < len(pins) and pins[ch] else ""
        if pin and "not connected" not in pin.lower():
            base_label = pin if re.search(r"\b\d+\s*$", pin) else f"{pin} {ch + 1}"
        else:
            base_label = f"{safe_name} {ch + 1}"
        catalog.append(
            {
                "id": str(ch),
                "index": ch,
                "code": code,
                "label": f"[{code}] {base_label}",
                "group": "Mono",
            }
        )

    pair_count = total // 2
    for pair_idx in range(pair_count):
        c1 = pair_idx * 2
        c2 = c1 + 1
        code = f"{pair_idx + 1:02d}S"
        ch_id = "stereo" if pair_idx == 0 else f"stereo:{c1}:{c2}"
        catalog.append(
            {
                "id": ch_id,
                "indices": [c1, c2],
                "code": code,
                "label": f"[{code}] {safe_name} {c1 + 1}/{c2 + 1}",
                "group": "Stereo",
            }
        )
    return catalog


def _resolve_single_bus(channel_arrays, frames, spec, fallback_ch=0):
    num_ch = len(channel_arrays)
    if frames <= 0 or num_ch == 0:
        return [0.0] * max(0, frames)
    s = str(spec if spec is not None else fallback_ch).strip().lower()
    if s in ("none", "off", "-1", ""):
        return [0.0] * frames
    if s == "stereo":
        c0 = channel_arrays[0]
        c1 = channel_arrays[1] if num_ch > 1 else c0
        return [0.5 * (c0[i] + c1[i]) for i in range(frames)]
    if s.startswith("stereo:"):
        parts = s.split(":")[1:]
        i0 = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
        i1 = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else (i0 + 1)
        i0 = i0 if 0 <= i0 < num_ch else 0
        i1 = i1 if 0 <= i1 < num_ch else i0
        c0 = channel_arrays[i0]
        c1 = channel_arrays[i1]
        return [0.5 * (c0[i] + c1[i]) for i in range(frames)]
    if s.isdigit():
        idx = int(s)
        if 0 <= idx < num_ch:
            src = channel_arrays[idx]
            return src if isinstance(src, list) else list(src)
        return [0.0] * frames
    return [0.0] * frames


def route_channels_frame(channel_arrays, frames, routing):
    """Routes multi-channel physical inputs cleanly to Studio Bus 1 (Vocals) & Bus 2 (Inst)."""
    rt = routing if isinstance(routing, dict) else {}
    ch1_spec = rt.get("ch1", "0")
    ch2_spec = rt.get("ch2", "1" if len(channel_arrays) > 1 else "none")
    bus1 = _resolve_single_bus(channel_arrays, frames, ch1_spec, fallback_ch=0)
    bus2 = _resolve_single_bus(channel_arrays, frames, ch2_spec, fallback_ch=1)
    return bus1, bus2


def pack_bpas_packet(ch1_floats, ch2_floats):
    frames = len(ch1_floats)
    header = struct.pack("<4sI", b"BPAS", frames)
    fmt = f"<{frames}f"
    payload1 = struct.pack(fmt, *ch1_floats)
    payload2 = struct.pack(fmt, *ch2_floats) if ch2_floats is not None else b""
    return header + payload1 + payload2


def pack_bpmc_packet(channel_arrays, frames):
    """Packs N-channel raw hardware Float32 planar audio frames (magic='BPMC', num_ch u16, frames u16)."""
    n_ch = len(channel_arrays)
    nf = int(frames)
    header = struct.pack("<4sHH", b"BPMC", n_ch, nf)
    fmt = f"<{nf}f"
    payload = b"".join(struct.pack(fmt, *(ch[:nf])) for ch in channel_arrays)
    return header + payload


def enumerate_windows_asio_registry():
    """Reads registered ASIO drivers directly from Windows Registry (HKLM\\SOFTWARE\\ASIO)."""
    if sys.platform != "win32":
        return []
    drivers = []
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\ASIO") as key:
            count = winreg.QueryInfoKey(key)[0]
            for i in range(count):
                sub_name = winreg.EnumKey(key, i)
                desc = sub_name
                clsid_str = ""
                dll_path = ""
                try:
                    with winreg.OpenKey(key, sub_name) as sub:
                        try:
                            desc, _ = winreg.QueryValueEx(sub, "Description")
                        except OSError:
                            pass
                        try:
                            clsid_str, _ = winreg.QueryValueEx(sub, "CLSID")
                        except OSError:
                            pass
                except OSError:
                    pass
                if clsid_str:
                    try:
                        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, rf"CLSID\{clsid_str}\InprocServer32") as ck:
                            dll_path, _ = winreg.QueryValueEx(ck, "")
                    except OSError:
                        pass
                drivers.append({"name": sub_name, "description": desc, "clsid": clsid_str, "dllPath": dll_path})
    except OSError:
        pass
    return drivers


# ==============================================================================
# NATIVE WINDOWS COM DEFINITIONS (WASAPI EXCLUSIVE + 64-BIT COM ASIO)
# ==============================================================================

if sys.platform == "win32":
    class _COM_GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_uint32),
            ("Data2", ctypes.c_uint16),
            ("Data3", ctypes.c_uint16),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    def _guid(s):
        return _COM_GUID.from_buffer_copy(uuid.UUID(s).bytes_le)

    class _PROPERTYKEY(ctypes.Structure):
        _fields_ = [("fmtid", _COM_GUID), ("pid", ctypes.c_uint32)]

    class _PROPVARIANT(ctypes.Structure):
        _fields_ = [
            ("vt", ctypes.c_uint16),
            ("wReserved1", ctypes.c_uint16),
            ("wReserved2", ctypes.c_uint16),
            ("wReserved3", ctypes.c_uint16),
            ("pVal", ctypes.c_void_p),
            ("pPad", ctypes.c_void_p),
        ]

    class _WAVEFORMATEX(ctypes.Structure):
        _pack_ = 1
        _fields_ = [
            ("wFormatTag", ctypes.c_uint16),
            ("nChannels", ctypes.c_uint16),
            ("nSamplesPerSec", ctypes.c_uint32),
            ("nAvgBytesPerSec", ctypes.c_uint32),
            ("nBlockAlign", ctypes.c_uint16),
            ("wBitsPerSample", ctypes.c_uint16),
            ("cbSize", ctypes.c_uint16),
        ]

    class _WAVEFORMATEXTENSIBLE(ctypes.Structure):
        _pack_ = 1
        _fields_ = [
            ("Format", _WAVEFORMATEX),
            ("wValidBitsPerSample", ctypes.c_uint16),
            ("dwChannelMask", ctypes.c_uint32),
            ("SubFormat", _COM_GUID),
        ]

    class _ASIOChannelInfo(ctypes.Structure):
        _pack_ = 4
        _fields_ = [
            ("channel", ctypes.c_int32),
            ("isInput", ctypes.c_int32),
            ("isActive", ctypes.c_int32),
            ("channelGroup", ctypes.c_int32),
            ("type", ctypes.c_int32),
            ("name", ctypes.c_char * 32),
        ]

    class _ASIOBufferInfo(ctypes.Structure):
        _pack_ = 4
        _fields_ = [
            ("isInput", ctypes.c_int32),
            ("channelNum", ctypes.c_int32),
            ("buffers", ctypes.c_void_p * 2),
        ]

    class _ASIOCallbacks(ctypes.Structure):
        _fields_ = [
            ("bufferSwitch", ctypes.c_void_p),
            ("sampleRateDidChange", ctypes.c_void_p),
            ("asioMessage", ctypes.c_void_p),
            ("bufferSwitchTimeInfo", ctypes.c_void_p),
        ]

    CLSID_MMDeviceEnumerator = _guid("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
    IID_IMMDeviceEnumerator = _guid("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
    IID_IAudioClient = _guid("{1CB9AD4C-DBFA-4c32-B178-C2F568A703B2}")
    IID_IAudioCaptureClient = _guid("{C8ADBD64-E71E-48a0-A4DE-185C395CD317}")
    PKEY_Device_DeviceDesc = _PROPERTYKEY(_guid("{a45c254e-df1c-4efd-8020-67d146a850e0}"), 2)
    PKEY_Device_FriendlyName = _PROPERTYKEY(_guid("{a45c254e-df1c-4efd-8020-67d146a850e0}"), 14)
    PKEY_Device_EnumeratorName = _PROPERTYKEY(_guid("{a45c254e-df1c-4efd-8020-67d146a850e0}"), 24)
    PKEY_DeviceInterface_FriendlyName = _PROPERTYKEY(_guid("{026e516e-b814-414b-83cd-856d6fef4822}"), 2)
    PKEY_Device_BusReportedDeviceDesc = _PROPERTYKEY(_guid("{540b947e-8b40-45bc-a8a2-6a0b894cbda2}"), 4)
    PKEY_AudioEndpoint_FormFactor = _PROPERTYKEY(_guid("{1da5d803-d492-4edd-8c23-e0c0ffee7f0e}"), 0)
    KSDATAFORMAT_SUBTYPE_PCM = _guid("{00000001-0000-0010-8000-00aa00389b71}")
    KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = _guid("{00000003-0000-0010-8000-00aa00389b71}")

    _WIN32_APIS = None

    def _get_win32_apis():
        global _WIN32_APIS
        if _WIN32_APIS is not None:
            return _WIN32_APIS
        ole32 = ctypes.windll.ole32
        user32 = ctypes.windll.user32

        ole32.CoInitialize.argtypes = [ctypes.c_void_p]
        ole32.CoInitialize.restype = ctypes.c_int32
        ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        ole32.CoInitializeEx.restype = ctypes.c_int32
        ole32.CoUninitialize.argtypes = []
        ole32.CoUninitialize.restype = None
        ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
        ole32.CoTaskMemFree.restype = None
        ole32.CoCreateInstance.argtypes = [
            ctypes.POINTER(_COM_GUID),
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(_COM_GUID),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        ole32.CoCreateInstance.restype = ctypes.c_int32

        user32.CreateWindowExW.argtypes = [
            ctypes.c_uint32,
            ctypes.c_wchar_p,
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_int32,
            ctypes.c_int32,
            ctypes.c_int32,
            ctypes.c_int32,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        user32.CreateWindowExW.restype = ctypes.c_void_p
        user32.DestroyWindow.argtypes = [ctypes.c_void_p]
        user32.DestroyWindow.restype = ctypes.c_int32
        user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32]
        user32.PeekMessageW.restype = ctypes.c_int32
        user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        user32.TranslateMessage.restype = ctypes.c_int32
        user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        user32.DispatchMessageW.restype = ctypes.c_ssize_t

        _WIN32_APIS = (ole32, user32)
        return _WIN32_APIS


def _make_waveformat(channels, rate, bits, is_float=False):
    block_align = channels * (bits // 8)
    if is_float or bits == 24 or channels > 2:
        wf = _WAVEFORMATEXTENSIBLE()
        wf.Format.wFormatTag = 0xFFFE
        wf.Format.nChannels = channels
        wf.Format.nSamplesPerSec = rate
        wf.Format.nAvgBytesPerSec = rate * block_align
        wf.Format.nBlockAlign = block_align
        wf.Format.wBitsPerSample = bits
        wf.Format.cbSize = 22
        wf.wValidBitsPerSample = bits
        wf.dwChannelMask = 0x3 if channels == 2 else (0x1 if channels == 1 else ((1 << channels) - 1))
        wf.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT if is_float else KSDATAFORMAT_SUBTYPE_PCM
        return wf
    return _WAVEFORMATEX(
        wFormatTag=1,
        nChannels=channels,
        nSamplesPerSec=rate,
        nAvgBytesPerSec=rate * block_align,
        nBlockAlign=block_align,
        wBitsPerSample=bits,
        cbSize=0,
    )


def _probe_wasapi_exclusive_format(ac_vtbl, ac_ptr, preferred_rate=48000):
    is_supported = ctypes.WINFUNCTYPE(
        ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p
    )(ac_vtbl[7])

    rates = [preferred_rate, 44100] if preferred_rate != 44100 else [44100, 48000]
    for ch in (8, 6, 4, 2, 1):
        for rate in rates:
            for bits, is_float in ((24, False), (32, True), (16, False), (32, False)):
                wf = _make_waveformat(ch, rate, bits, is_float=is_float)
                hr = is_supported(ac_ptr, AUDCLNT_SHAREMODE_EXCLUSIVE, ctypes.byref(wf), None)
                if hr == 0:
                    return {
                        "channels": ch,
                        "rate": rate,
                        "bits": bits,
                        "isFloat": is_float,
                    }
    return None


def _read_prop_value(ole32, svt, store, pkey):
    pv = _PROPVARIANT()
    hr = ctypes.WINFUNCTYPE(
        ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(_PROPERTYKEY), ctypes.POINTER(_PROPVARIANT)
    )(svt[5])(store, ctypes.byref(pkey), ctypes.byref(pv))
    if hr != 0:
        return None
    if pv.vt == 31 and pv.pVal:  # VT_LPWSTR
        val = ctypes.wstring_at(pv.pVal)
        ole32.CoTaskMemFree(ctypes.c_void_p(pv.pVal))
        return val
    if pv.vt == 19:  # VT_UI4
        return int(pv.pVal or 0) & 0xFFFFFFFF
    return None


def _get_active_capture_endpoint_ids():
    """Returns frozenset of currently ACTIVE Core Audio capture IMMDevice endpoint IDs."""
    if sys.platform != "win32":
        return frozenset()
    ids = set()
    coinit_done = False
    try:
        ole32, _ = _get_win32_apis()
        hr_co = ole32.CoInitialize(None)
        coinit_done = hr_co in (0, 1)
        enum_ptr = ctypes.c_void_p()
        hr = ole32.CoCreateInstance(
            ctypes.byref(CLSID_MMDeviceEnumerator), None, 1, ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(enum_ptr)
        )
        if hr != 0 or not enum_ptr.value:
            return frozenset()
        evt = ctypes.cast(ctypes.cast(enum_ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        coll = ctypes.c_void_p()
        ctypes.WINFUNCTYPE(
            ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
        )(evt[3])(enum_ptr, 1, 1, ctypes.byref(coll))
        if coll.value:
            cvt = ctypes.cast(ctypes.cast(coll, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
            cnt = ctypes.c_uint32()
            ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))(cvt[3])(coll, ctypes.byref(cnt))
            for idx in range(cnt.value):
                dev = ctypes.c_void_p()
                if ctypes.WINFUNCTYPE(
                    ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
                )(cvt[4])(coll, idx, ctypes.byref(dev)) == 0 and dev.value:
                    dvt = ctypes.cast(ctypes.cast(dev, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    id_ptr = ctypes.c_wchar_p()
                    if ctypes.WINFUNCTYPE(
                        ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)
                    )(dvt[5])(dev, ctypes.byref(id_ptr)) == 0 and id_ptr.value:
                        ids.add(id_ptr.value)
                        ole32.CoTaskMemFree(ctypes.cast(id_ptr, ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(dvt[2])(dev)
            ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(cvt[2])(coll)
        ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(evt[2])(enum_ptr)
    except Exception:
        return frozenset()
    finally:
        if coinit_done:
            ole32.CoUninitialize()
    return frozenset(ids)


def _enumerate_wasapi_devices(include_loopback=False):
    """Enumerates active Windows audio inputs with true Core Audio PnP topology and WASAPI Exclusive capabilities."""
    if sys.platform != "win32":
        return []
    out = []
    coinit_done = False
    try:
        ole32, _ = _get_win32_apis()
        hr_co = ole32.CoInitialize(None)
        coinit_done = hr_co in (0, 1)
        enum_ptr = ctypes.c_void_p()
        hr = ole32.CoCreateInstance(
            ctypes.byref(CLSID_MMDeviceEnumerator),
            None,
            1,
            ctypes.byref(IID_IMMDeviceEnumerator),
            ctypes.byref(enum_ptr),
        )
        if hr != 0 or not enum_ptr.value:
            return []

        evt = ctypes.cast(ctypes.cast(enum_ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))

        # Check unplugged HDAUDIO jack state for accurate topology hint on onboard devices
        has_unplugged_hd_jack = False
        all_coll = ctypes.c_void_p()
        ctypes.WINFUNCTYPE(
            ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
        )(evt[3])(enum_ptr, 1, 0x8, ctypes.byref(all_coll))
        if all_coll.value:
            acvt_all = ctypes.cast(ctypes.cast(all_coll, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
            unplugged_cnt = ctypes.c_uint32()
            ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))(acvt_all[3])(
                all_coll, ctypes.byref(unplugged_cnt)
            )
            has_unplugged_hd_jack = unplugged_cnt.value > 0
            ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(acvt_all[2])(all_coll)

        coll = ctypes.c_void_p()
        ctypes.WINFUNCTYPE(
            ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
        )(evt[3])(enum_ptr, 1, 1, ctypes.byref(coll))
        if not coll.value:
            ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(evt[2])(enum_ptr)
            return []

        cvt = ctypes.cast(ctypes.cast(coll, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        cnt = ctypes.c_uint32()
        ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))(cvt[3])(
            coll, ctypes.byref(cnt)
        )

        for idx in range(cnt.value):
            dev = ctypes.c_void_p()
            if ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
            )(cvt[4])(coll, idx, ctypes.byref(dev)) != 0:
                continue
            dvt = ctypes.cast(ctypes.cast(dev, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))

            # Device Endpoint ID
            ep_id = str(idx)
            id_ptr = ctypes.c_wchar_p()
            if ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)
            )(dvt[5])(dev, ctypes.byref(id_ptr)) == 0 and id_ptr.value:
                ep_id = id_ptr.value
                ole32.CoTaskMemFree(ctypes.cast(id_ptr, ctypes.c_void_p))

            # Core Audio Property Store (FriendlyName, EnumeratorName USB/HDAUDIO/ROOT, FormFactor)
            fname = f"Audio Device {idx}"
            enumerator = ""
            iface_name = ""
            bus_desc = ""
            ep_desc = ""
            form_factor = 0
            store = ctypes.c_void_p()
            if ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
            )(dvt[4])(dev, 0, ctypes.byref(store)) == 0 and store.value:
                svt = ctypes.cast(
                    ctypes.cast(store, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p)
                )
                fname = _read_prop_value(ole32, svt, store, PKEY_Device_FriendlyName) or fname
                enumerator = str(_read_prop_value(ole32, svt, store, PKEY_Device_EnumeratorName) or "")
                iface_name = str(_read_prop_value(ole32, svt, store, PKEY_DeviceInterface_FriendlyName) or "")
                bus_desc = str(_read_prop_value(ole32, svt, store, PKEY_Device_BusReportedDeviceDesc) or "")
                ep_desc = str(_read_prop_value(ole32, svt, store, PKEY_Device_DeviceDesc) or "")
                ff_val = _read_prop_value(ole32, svt, store, PKEY_AudioEndpoint_FormFactor)
                if isinstance(ff_val, int):
                    form_factor = ff_val
                ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(svt[2])(store)

            ac = ctypes.c_void_p()
            hr_ac = ctypes.WINFUNCTYPE(
                ctypes.c_int32,
                ctypes.c_void_p,
                ctypes.POINTER(_COM_GUID),
                ctypes.c_uint32,
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_void_p),
            )(dvt[3])(dev, ctypes.byref(IID_IAudioClient), 1, None, ctypes.byref(ac))

            shared_ch = 2
            excl_fmt = None
            if hr_ac == 0 and ac.value:
                acvt = ctypes.cast(
                    ctypes.cast(ac, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p)
                )
                mix_ptr = ctypes.POINTER(_WAVEFORMATEX)()
                if ctypes.WINFUNCTYPE(
                    ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(_WAVEFORMATEX))
                )(acvt[8])(ac, ctypes.byref(mix_ptr)) == 0 and mix_ptr:
                    shared_ch = int(mix_ptr.contents.nChannels)
                    ole32.CoTaskMemFree(mix_ptr)
                excl_fmt = _probe_wasapi_exclusive_format(acvt, ac, DEFAULT_RATE)
                ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(acvt[2])(ac)

            ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(dvt[2])(dev)

            if not excl_fmt:
                continue

            is_loopback = (form_factor == 10) or ("stereo mix" in ep_desc.lower()) or ("stereo mix" in fname.lower())
            if is_loopback and not include_loopback:
                continue

            bus_upper = enumerator.strip().upper()
            if is_loopback:
                dev_category = "loopback"
            elif bus_upper in ("USB", "USB4", "1394", "THUNDERBOLT"):
                dev_category = "external_interface"
            elif bus_upper in ("ROOT", "SWD", "BTHENUM", "BTHHFENUM"):
                dev_category = "virtual"
            else:
                dev_category = "onboard"

            meta_clean = re.sub(r"^\d+\s*-\s*", "", (bus_desc or iface_name or "")).strip()
            clean = meta_clean or clean_hardware_name(fname)
            topo_hint = (
                "USB Hardware"
                if dev_category == "external_interface"
                else ("Virtual Audio Driver" if dev_category == "virtual" else ("Built-in Array" + (" (Ext Jack Unplugged)" if has_unplugged_hd_jack else "")))
            )
            out.append(
                {
                    "id": f"wasapi_excl:{idx}",
                    "endpointId": ep_id,
                    "index": idx,
                    "name": fname,
                    "cleanName": clean,
                    "busType": bus_upper or "UNKNOWN",
                    "deviceCategory": dev_category,
                    "isLoopback": is_loopback,
                    "topologyHint": topo_hint,
                    "hostApi": "WASAPI Exclusive",
                    "isAsio": False,
                    "isExclusive": True,
                    "backend": "wasapi_exclusive",
                    "maxInputChannels": excl_fmt["channels"],
                    "sharedChannels": shared_ch,
                    "defaultSampleRate": excl_fmt["rate"],
                    "bitDepth": excl_fmt["bits"],
                    "isFloat": excl_fmt["isFloat"],
                    "channelsCatalog": build_audition_channel_catalog(clean, excl_fmt["channels"]),
                }
            )
        ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(cvt[2])(coll)
        ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(evt[2])(enum_ptr)
    except Exception:
        return []
    finally:
        if coinit_done:
            ole32.CoUninitialize()
    return out


def _run_asio_probe_worker(drv_name, clsid_str):
    """Probes a single 64-bit COM IASIO driver inside an isolated child process."""
    if sys.platform != "win32" or not clsid_str:
        print(json.dumps({"ok": False, "error": "Unsupported platform or empty CLSID"}), flush=True)
        os._exit(0)
    try:
        ole32, user32 = _get_win32_apis()
        ole32.CoInitialize(None)
        hwnd = user32.CreateWindowExW(0, "STATIC", "BPAsioProbe", 0, 0, 0, 0, 0, None, None, None, None)
        clsid = _guid(clsid_str)
        ptr = ctypes.c_void_p()
        hr = ole32.CoCreateInstance(ctypes.byref(clsid), None, 1, ctypes.byref(clsid), ctypes.byref(ptr))
        if hr != 0 or not ptr.value:
            print(json.dumps({"ok": False, "error": f"CoCreateInstance failed ({hex(hr & 0xFFFFFFFF)})"}), flush=True)
            os._exit(0)

        vtbl = ctypes.cast(ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        init_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p)(vtbl[3])
        ch_fn = ctypes.WINFUNCTYPE(
            ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int32), ctypes.POINTER(ctypes.c_int32)
        )(vtbl[9])
        sr_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_double))(vtbl[13])
        info_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(_ASIOChannelInfo))(vtbl[18])

        pin_names = []
        nin_val = 0
        sr_val = DEFAULT_RATE
        if init_fn(ptr, hwnd):
            nin, nout = ctypes.c_int32(), ctypes.c_int32()
            ch_fn(ptr, ctypes.byref(nin), ctypes.byref(nout))
            sr = ctypes.c_double()
            if sr_fn(ptr, ctypes.byref(sr)) == 0 and sr.value > 0:
                sr_val = int(round(sr.value))
            nin_val = max(0, int(nin.value))
            for ch in range(nin_val):
                ci = _ASIOChannelInfo(channel=ch, isInput=1)
                if info_fn(ptr, ctypes.byref(ci)) == 0:
                    pin_names.append(ci.name.decode("latin1", errors="ignore").rstrip("\x00"))
                else:
                    pin_names.append(f"Input {ch + 1}")
        print(
            json.dumps({"ok": nin_val > 0, "name": drv_name, "channels": nin_val, "sampleRate": sr_val, "pinNames": pin_names}),
            flush=True,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
    os._exit(0)


def _enumerate_asio_com_devices(has_active_external_usb=False):
    """Enumerates registered 64-bit ASIO drivers cleanly via isolated probe subprocesses."""
    if sys.platform != "win32":
        return []
    drivers = enumerate_windows_asio_registry()
    if not drivers:
        return []
    out = []
    script_path = os.path.abspath(__file__)
    no_win = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    for drv in drivers:
        clsid_str = drv.get("clsid") or ""
        if not clsid_str:
            continue
        try:
            res = subprocess.run(
                [sys.executable, "-u", script_path, "--asio-probe-single", drv["name"], clsid_str],
                capture_output=True,
                text=True,
                timeout=3.5,
                creationflags=no_win,
            )
            if res.returncode != 0 or not res.stdout.strip():
                continue
            info = json.loads(res.stdout.strip().splitlines()[-1])
            nin_val = int(info.get("channels") or 0)
            if not info.get("ok") or nin_val <= 0:
                continue
            pin_names = list(info.get("pinNames") or [])
            sr_val = int(info.get("sampleRate") or DEFAULT_RATE)
            dll_lower = str(drv.get("dllPath") or "").lower()
            is_system_dir = ("\\windows\\system32\\" in dll_lower) or ("\\windows\\syswow64\\" in dll_lower)
            is_generic_wrapper = "asio4all" in dll_lower
            all_hd_pins = bool(pin_names) and all("hd audio" in str(p).lower() for p in pin_names)
            if not is_system_dir and not is_generic_wrapper:
                dev_category = "external_interface"
                bus_type = "ASIO"
            elif is_generic_wrapper and has_active_external_usb and not all_hd_pins:
                dev_category = "external_interface"
                bus_type = "ASIO_WRAPPER"
            else:
                dev_category = "onboard_asio"
                bus_type = "ASIO_ONBOARD"
            clean = clean_hardware_name(drv["name"])
            out.append(
                {
                    "id": f"asio:{drv['name']}",
                    "clsid": clsid_str,
                    "dllPath": drv.get("dllPath") or "",
                    "index": drv["name"],
                    "name": f"{drv['name']} ({', '.join(pin_names[:2])})" if pin_names else drv["name"],
                    "cleanName": clean,
                    "busType": bus_type,
                    "deviceCategory": dev_category,
                    "isLoopback": False,
                    "topologyHint": "Dedicated ASIO Driver" if dev_category == "external_interface" else "Onboard System ASIO",
                    "hostApi": "ASIO",
                    "isAsio": True,
                    "isExclusive": True,
                    "backend": "asio_com",
                    "maxInputChannels": nin_val,
                    "defaultSampleRate": sr_val,
                    "pinNames": pin_names,
                    "channelsCatalog": build_audition_channel_catalog(clean, nin_val, pin_names),
                }
            )
        except Exception:
            continue
    return out


def _enumerate_winmm_devices():
    """Enumerates Windows WaveIn audio capture devices using ctypes.windll.winmm."""
    if sys.platform != "win32":
        return []

    class WAVEINCAPSW(ctypes.Structure):
        _fields_ = [
            ("wMid", wintypes.WORD),
            ("wPid", wintypes.WORD),
            ("vDriverVersion", wintypes.UINT),
            ("szPname", wintypes.WCHAR * 32),
            ("dwFormats", wintypes.DWORD),
            ("wChannels", wintypes.WORD),
            ("wReserved1", wintypes.WORD),
        ]

    class WAVEFORMATEX_Q(ctypes.Structure):
        _fields_ = [
            ("wFormatTag", wintypes.WORD),
            ("nChannels", wintypes.WORD),
            ("nSamplesPerSec", wintypes.DWORD),
            ("nAvgBytesPerSec", wintypes.DWORD),
            ("nBlockAlign", wintypes.WORD),
            ("wBitsPerSample", wintypes.WORD),
            ("cbSize", wintypes.WORD),
        ]

    winmm = ctypes.windll.winmm
    num_devs = int(winmm.waveInGetNumDevs())
    out = []
    for idx in range(num_devs):
        caps = WAVEINCAPSW()
        rc = winmm.waveInGetDevCapsW(idx, ctypes.byref(caps), ctypes.sizeof(caps))
        if rc == 0:
            ch = int(caps.wChannels)
            if ch <= 0 or ch > 32:
                # Probe actual hardware format support via WAVE_FORMAT_QUERY (0x0001) instead of guessing 2ch
                probed_ch = 0
                for cand_ch in (2, 1):
                    ba = cand_ch * 2
                    wfx_q = WAVEFORMATEX_Q(
                        wFormatTag=1,
                        nChannels=cand_ch,
                        nSamplesPerSec=DEFAULT_RATE,
                        nAvgBytesPerSec=DEFAULT_RATE * ba,
                        nBlockAlign=ba,
                        wBitsPerSample=16,
                        cbSize=0,
                    )
                    if winmm.waveInOpen(None, idx, ctypes.byref(wfx_q), 0, 0, 0x0001) == 0:
                        probed_ch = cand_ch
                        break
                ch = probed_ch or 1
            clean = clean_hardware_name(caps.szPname)
            out.append(
                {
                    "id": f"winmm:{idx}",
                    "index": idx,
                    "name": caps.szPname,
                    "cleanName": clean,
                    "hostApi": "Windows MME (Shared Fallback)",
                    "isAsio": False,
                    "isExclusive": False,
                    "backend": "winmm",
                    "maxInputChannels": ch,
                    "defaultSampleRate": DEFAULT_RATE,
                    "channelsCatalog": build_audition_channel_catalog(clean, ch),
                }
            )
    return out


def list_audio_devices(include_loopback=False):
    asio_regs = enumerate_windows_asio_registry()
    reg_names = [r["name"] for r in asio_regs]

    if sys.platform == "win32":
        wasapi_devs = _enumerate_wasapi_devices(include_loopback=include_loopback)
        has_ext_usb = any(d.get("deviceCategory") == "external_interface" for d in wasapi_devs)
        asio_com_devs = _enumerate_asio_com_devices(has_active_external_usb=has_ext_usb)
        # Skip duplicate MME devices when WASAPI Exclusive already exposes the endpoint
        combined = wasapi_devs + asio_com_devs
        if not wasapi_devs:
            combined = combined + _enumerate_winmm_devices()
        for d in combined:
            d["registeredAsioDrivers"] = reg_names
        return combined

    try:
        import sounddevice as sd

        host_apis = sd.query_hostapis()
        devices = sd.query_devices()
        sd_out = []
        for idx, dev in enumerate(devices):
            ch = int(dev.get("max_input_channels", 0))
            if ch < 1:
                continue
            api_idx = int(dev.get("hostapi", 0))
            api_name = host_apis[api_idx]["name"] if api_idx < len(host_apis) else "Unknown"
            name = dev.get("name", f"Device {idx}")
            clean = clean_hardware_name(name)
            is_asio = "asio" in api_name.lower()
            sd_out.append(
                {
                    "id": f"sd:{idx}",
                    "index": idx,
                    "name": name,
                    "cleanName": clean,
                    "hostApi": api_name,
                    "isAsio": is_asio,
                    "isExclusive": is_asio or ("exclusive" in api_name.lower()),
                    "deviceCategory": "external_interface" if is_asio else "onboard",
                    "backend": "sounddevice",
                    "maxInputChannels": ch,
                    "defaultSampleRate": int(dev.get("default_samplerate", DEFAULT_RATE)),
                    "channelsCatalog": build_audition_channel_catalog(clean, ch),
                    "registeredAsioDrivers": reg_names,
                }
            )
        return sd_out
    except ImportError:
        return []


def resolve_device_index(devices, requested_name, allow_onboard_fallback=False):
    if requested_name:
        needle = str(requested_name).strip().lower()
        if needle in ("none", "standby", "off"):
            return None
        for dev in devices:
            if str(dev.get("id", "")).lower() == needle:
                return dev
        excl_matches = [d for d in devices if needle in d["name"].lower() and d.get("isExclusive")]
        if excl_matches:
            return excl_matches[0]
        any_matches = [d for d in devices if needle in d["name"].lower()]
        if any_matches:
            return any_matches[0]

    ext_devs = [d for d in devices if d.get("deviceCategory") == "external_interface"]
    if ext_devs:
        ext_asio = [d for d in ext_devs if d.get("isAsio") and d.get("maxInputChannels", 0) >= 2]
        if ext_asio:
            return ext_asio[0]
        ext_wasapi = [d for d in ext_devs if d.get("backend") == "wasapi_exclusive" and d.get("maxInputChannels", 0) >= 2]
        if ext_wasapi:
            return ext_wasapi[0]
        return ext_devs[0]

    if not allow_onboard_fallback:
        return None

    stereo_any = [d for d in devices if d.get("maxInputChannels", 0) >= 2]
    return stereo_any[0] if stereo_any else (devices[0] if devices else None)


# ==============================================================================
# WEBSOCKET PROTOCOL HELPERS
# ==============================================================================

def _ws_build_frame(opcode, data_bytes):
    length = len(data_bytes)
    header = bytearray([0x80 | (opcode & 0x0F)])
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + data_bytes


class StdlibWsClient:
    """Minimal asyncio WebSocket peer supporting RFC-6455 text/binary frames."""

    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.closed = False

    async def send_text(self, text):
        if self.closed:
            return
        self.writer.write(_ws_build_frame(0x1, text.encode("utf-8")))
        await self.writer.drain()

    async def send_binary(self, payload):
        if self.closed:
            return
        self.writer.write(_ws_build_frame(0x2, payload))
        await self.writer.drain()

    async def read_message(self):
        hdr = await self.reader.readexactly(2)
        opcode = hdr[0] & 0x0F
        masked = bool(hdr[1] & 0x80)
        length = hdr[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", await self.reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await self.reader.readexactly(8))[0]
        mask_key = await self.reader.readexactly(4) if masked else b""
        payload = bytearray(await self.reader.readexactly(length)) if length > 0 else bytearray()
        if masked and length > 0:
            for i in range(length):
                payload[i] ^= mask_key[i % 4]
        if opcode == 0x8:
            self.closed = True
            return None
        if opcode == 0x9:
            self.writer.write(_ws_build_frame(0xA, bytes(payload)))
            await self.writer.drain()
            return ""
        if opcode == 0x1:
            return payload.decode("utf-8", errors="replace")
        return ""

    def close(self):
        self.closed = True
        try:
            self.writer.close()
        except Exception:
            pass


# ==============================================================================
# CAPTURE BACKENDS (WASAPI EXCLUSIVE, COM ASIO, SOUNDDEVICE, WINMM FALLBACK)
# ==============================================================================

def _decode_interleaved_pcm(raw_bytes, n_frames, channels, bits, is_float=False):
    ch_arrays = [[] for _ in range(channels)]
    total_samples = n_frames * channels
    if total_samples <= 0:
        return ch_arrays

    if is_float and bits == 32:
        floats = struct.unpack(f"<{total_samples}f", raw_bytes)
        for i in range(n_frames):
            base = i * channels
            for c in range(channels):
                ch_arrays[c].append(float(floats[base + c]))
    elif bits == 16:
        shorts = struct.unpack(f"<{total_samples}h", raw_bytes)
        inv = 1.0 / 32768.0
        for i in range(n_frames):
            base = i * channels
            for c in range(channels):
                ch_arrays[c].append(shorts[base + c] * inv)
    elif bits == 24:
        inv = 1.0 / 8388608.0
        mv = memoryview(raw_bytes)
        for i in range(n_frames):
            base = i * channels * 3
            for c in range(channels):
                off = base + c * 3
                b0, b1, b2 = mv[off], mv[off + 1], mv[off + 2]
                val = b0 | (b1 << 8) | ((b2 if b2 < 128 else b2 - 256) << 16)
                ch_arrays[c].append(val * inv)
    elif bits == 32:
        ints = struct.unpack(f"<{total_samples}i", raw_bytes)
        inv = 1.0 / 2147483648.0
        for i in range(n_frames):
            base = i * channels
            for c in range(channels):
                ch_arrays[c].append(ints[base + c] * inv)
    return ch_arrays


def _push_audio_frame_block(
    ch_arrays, nf, routing_state, pcm_queue, stats, level_tracker=None, raw_mc_queue=None, raw_mc_state=None
):
    """Updates pin telemetry, pushes optional BPMC multichannel frames, and emits routed BPAS packets."""
    if level_tracker is not None:
        level_tracker.update(ch_arrays, nf)
    if raw_mc_queue is not None and raw_mc_state and raw_mc_state.get("enabled"):
        try:
            raw_mc_queue.put_nowait(pack_bpmc_packet(ch_arrays, nf))
        except queue.Full:
            pass
    b1, b2 = route_channels_frame(ch_arrays, nf, routing_state)
    pkt = pack_bpas_packet(b1, b2)
    try:
        pcm_queue.put_nowait(pkt)
    except queue.Full:
        stats["droppedFrames"] += nf


def _start_wasapi_exclusive_capture(
    device_info, blocksize, pcm_queue, stats, routing_state, stop_event, level_tracker=None, raw_mc_queue=None, raw_mc_state=None
):
    endpoint_id = device_info.get("endpointId")
    channels = int(device_info.get("maxInputChannels", 2))
    rate = int(device_info.get("defaultSampleRate", DEFAULT_RATE))
    bits = int(device_info.get("bitDepth", 16))
    is_float = bool(device_info.get("isFloat", False))
    frame_bytes = channels * (bits // 8)
    ready_evt = threading.Event()
    err_holder = [None]

    def _worker():
        ole32, _ = _get_win32_apis()
        ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED
        ac = ctypes.c_void_p()
        cap = ctypes.c_void_p()
        enum_ptr = ctypes.c_void_p()
        dev_ptr = ctypes.c_void_p()
        started = False

        try:
            hr_enum = ole32.CoCreateInstance(
                ctypes.byref(CLSID_MMDeviceEnumerator), None, 1, ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(enum_ptr)
            )
            if hr_enum != 0 or not enum_ptr.value:
                raise RuntimeError(f"IMMDeviceEnumerator creation failed ({hex(hr_enum & 0xFFFFFFFF)})")
            evt = ctypes.cast(ctypes.cast(enum_ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))

            # Try GetDevice by Endpoint ID first, else fall back to Collection[index]
            hr_get = ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_void_p)
            )(evt[5])(enum_ptr, str(endpoint_id), ctypes.byref(dev_ptr))
            if hr_get != 0 or not dev_ptr.value:
                coll = ctypes.c_void_p()
                hr_coll = ctypes.WINFUNCTYPE(
                    ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
                )(evt[3])(enum_ptr, 1, 1, ctypes.byref(coll))
                if hr_coll == 0 and coll.value:
                    cvt = ctypes.cast(ctypes.cast(coll, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(
                        ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)
                    )(cvt[4])(coll, int(device_info.get("index", 0)), ctypes.byref(dev_ptr))
                    ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(cvt[2])(coll)

            if not dev_ptr.value:
                raise RuntimeError(f"WASAPI audio endpoint not found: {device_info.get('name')}")

            dvt = ctypes.cast(ctypes.cast(dev_ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
            activate_fn = ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(_COM_GUID), ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
            )(dvt[3])
            hr_act = activate_fn(dev_ptr, ctypes.byref(IID_IAudioClient), 1, None, ctypes.byref(ac))
            if hr_act != 0 or not ac.value:
                raise RuntimeError(f"IAudioClient Activate failed ({hex(hr_act & 0xFFFFFFFF)})")
            acvt = ctypes.cast(ctypes.cast(ac, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))

            wf = _make_waveformat(channels, rate, bits, is_float=is_float)
            def_per = ctypes.c_int64()
            min_per = ctypes.c_int64()
            ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int64), ctypes.POINTER(ctypes.c_int64)
            )(acvt[9])(ac, ctypes.byref(def_per), ctypes.byref(min_per))
            buf_hns = max(int(def_per.value) * 2, 200000)

            init_fn = ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.c_int64, ctypes.c_int64, ctypes.c_void_p, ctypes.c_void_p
            )(acvt[3])
            hr = init_fn(ac, AUDCLNT_SHAREMODE_EXCLUSIVE, 0, buf_hns, 0, ctypes.byref(wf), None)

            if (hr & 0xFFFFFFFF) == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED:
                aligned_frames = ctypes.c_uint32()
                ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))(acvt[4])(
                    ac, ctypes.byref(aligned_frames)
                )
                ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(acvt[2])(ac)
                ac = ctypes.c_void_p()
                hr_act2 = activate_fn(dev_ptr, ctypes.byref(IID_IAudioClient), 1, None, ctypes.byref(ac))
                if hr_act2 != 0 or not ac.value:
                    raise RuntimeError(f"IAudioClient Re-Activate failed ({hex(hr_act2 & 0xFFFFFFFF)})")
                acvt = ctypes.cast(ctypes.cast(ac, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                buf_hns = int((10000000.0 * aligned_frames.value / rate) + 0.5)
                hr = ctypes.WINFUNCTYPE(
                    ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.c_int64, ctypes.c_int64, ctypes.c_void_p, ctypes.c_void_p
                )(acvt[3])(ac, AUDCLNT_SHAREMODE_EXCLUSIVE, 0, buf_hns, 0, ctypes.byref(wf), None)

            if hr != 0:
                code_u = hr & 0xFFFFFFFF
                if code_u == AUDCLNT_E_DEVICE_IN_USE:
                    raise RuntimeError(
                        "USB interface is locked in Exclusive Mode by another app (e.g. Adobe Audition). Close Audition and click Refresh."
                    )
                raise RuntimeError(f"WASAPI Exclusive Initialize failed ({hex(code_u)})")

            hr_svc = ctypes.WINFUNCTYPE(
                ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(_COM_GUID), ctypes.POINTER(ctypes.c_void_p)
            )(acvt[14])(ac, ctypes.byref(IID_IAudioCaptureClient), ctypes.byref(cap))
            if hr_svc != 0 or not cap.value:
                raise RuntimeError(f"IAudioCaptureClient GetService failed ({hex(hr_svc & 0xFFFFFFFF)})")
            capvt = ctypes.cast(ctypes.cast(cap, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
            get_next_pkt_sz = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))(capvt[5])
            get_buf = ctypes.WINFUNCTYPE(
                ctypes.c_int32,
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
                ctypes.POINTER(ctypes.c_uint32),
                ctypes.POINTER(ctypes.c_uint32),
                ctypes.c_void_p,
                ctypes.c_void_p,
            )(capvt[3])
            rel_buf = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32)(capvt[4])

            hr_st = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)(acvt[10])(ac)  # Start()
            if hr_st != 0:
                raise RuntimeError(f"WASAPI Start() failed ({hex(hr_st & 0xFFFFFFFF)})")
            started = True
            ready_evt.set()

            accum = [[] for _ in range(channels)]
            pkt_sz = ctypes.c_uint32()
            p_data = ctypes.POINTER(ctypes.c_ubyte)()
            n_frames = ctypes.c_uint32()
            flags = ctypes.c_uint32()

            while not stop_event.is_set():
                hr_np = get_next_pkt_sz(cap, ctypes.byref(pkt_sz))
                if hr_np != 0:
                    if (hr_np & 0xFFFFFFFF) == AUDCLNT_E_DEVICE_INVALIDATED:
                        stats["disconnected"] = True
                        raise RuntimeError("Audio interface disconnected")
                    time.sleep(0.004)
                    continue
                if pkt_sz.value == 0:
                    time.sleep(0.004)
                    continue
                while pkt_sz.value > 0 and not stop_event.is_set():
                    hr_gb = get_buf(cap, ctypes.byref(p_data), ctypes.byref(n_frames), ctypes.byref(flags), None, None)
                    if hr_gb != 0:
                        if (hr_gb & 0xFFFFFFFF) == AUDCLNT_E_DEVICE_INVALIDATED:
                            stats["disconnected"] = True
                            raise RuntimeError("Audio interface disconnected")
                        break
                    nf = int(n_frames.value)
                    if nf > 0:
                        if flags.value & 0x00000001:  # AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY
                            stats["xruns"] += 1
                        if (flags.value & 0x00000002) or not p_data:  # AUDCLNT_BUFFERFLAGS_SILENT or null data ptr
                            for c in range(channels):
                                accum[c].extend([0.0] * nf)
                        else:
                            raw = ctypes.string_at(p_data, nf * frame_bytes)
                            decoded = _decode_interleaved_pcm(raw, nf, channels, bits, is_float=is_float)
                            for c in range(channels):
                                accum[c].extend(decoded[c])
                    rel_buf(cap, nf)

                    while len(accum[0]) >= blocksize:
                        chunk_ch = [accum[c][:blocksize] for c in range(channels)]
                        for c in range(channels):
                            del accum[c][:blocksize]
                        _push_audio_frame_block(
                            chunk_ch,
                            blocksize,
                            routing_state,
                            pcm_queue,
                            stats,
                            level_tracker=level_tracker,
                            raw_mc_queue=raw_mc_queue,
                            raw_mc_state=raw_mc_state,
                        )

                    hr_np2 = get_next_pkt_sz(cap, ctypes.byref(pkt_sz))
                    if hr_np2 != 0:
                        if (hr_np2 & 0xFFFFFFFF) == AUDCLNT_E_DEVICE_INVALIDATED:
                            stats["disconnected"] = True
                            raise RuntimeError("Audio interface disconnected")
                        break
        except Exception as exc:
            err_holder[0] = str(exc)
            stats["warning"] = str(exc)
            ready_evt.set()
        finally:
            try:
                if started and ac.value:
                    acvt = ctypes.cast(ctypes.cast(ac, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)(acvt[11])(ac)
                if cap.value:
                    capvt = ctypes.cast(ctypes.cast(cap, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(capvt[2])(cap)
                if ac.value:
                    acvt = ctypes.cast(ctypes.cast(ac, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(acvt[2])(ac)
                if dev_ptr.value:
                    dvt = ctypes.cast(ctypes.cast(dev_ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(dvt[2])(dev_ptr)
                if enum_ptr.value:
                    evt = ctypes.cast(ctypes.cast(enum_ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
                    ctypes.WINFUNCTYPE(ctypes.c_uint32, ctypes.c_void_p)(evt[2])(enum_ptr)
            except Exception:
                pass
            ole32.CoUninitialize()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    ready_evt.wait(timeout=3.0)
    return t, err_holder[0]


def _decode_asio_channel(buf_ptr, frames, sample_type):
    if not buf_ptr or frames <= 0:
        return [0.0] * max(0, frames)
    if sample_type == 16:  # ASIOSTInt16LSB
        raw = ctypes.string_at(buf_ptr, frames * 2)
        return [v / 32768.0 for v in struct.unpack(f"<{frames}h", raw)]
    if sample_type == 17:  # ASIOSTInt24LSB
        raw = ctypes.string_at(buf_ptr, frames * 3)
        mv = memoryview(raw)
        inv = 1.0 / 8388608.0
        out = []
        for i in range(frames):
            off = i * 3
            b0, b1, b2 = mv[off], mv[off + 1], mv[off + 2]
            out.append((b0 | (b1 << 8) | ((b2 if b2 < 128 else b2 - 256) << 16)) * inv)
        return out
    if sample_type == 18:  # ASIOSTInt32LSB
        raw = ctypes.string_at(buf_ptr, frames * 4)
        return [v / 2147483648.0 for v in struct.unpack(f"<{frames}i", raw)]
    if sample_type == 19:  # ASIOSTFloat32LSB
        raw = ctypes.string_at(buf_ptr, frames * 4)
        return list(struct.unpack(f"<{frames}f", raw))
    return [0.0] * frames


def _read_exact(stream, n):
    """Reads exactly n bytes from a binary stream, returning None on EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _run_asio_capture_worker(drv_name, clsid_str, requested_rate, max_channels):
    """Runs COM IASIO capture in an isolated child process, piping raw Float32 BPCH frames on binary stdout."""
    if sys.platform != "win32":
        os._exit(1)
    import msvcrt

    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    out_bin = sys.stdout.buffer

    def send_status(payload):
        raw = json.dumps(payload).encode("utf-8")
        out_bin.write(b"BPST" + struct.pack("<I", len(raw)) + raw)
        out_bin.flush()

    local_stop_evt = threading.Event()
    local_panel_evt = threading.Event()

    def _stdin_watcher():
        try:
            while not local_stop_evt.is_set():
                line = sys.stdin.readline()
                if not line:
                    local_stop_evt.set()
                    break
                cmd = line.strip().lower()
                if cmd == "stop":
                    local_stop_evt.set()
                    break
                if cmd == "panel":
                    local_panel_evt.set()
        except Exception:
            local_stop_evt.set()

    threading.Thread(target=_stdin_watcher, daemon=True).start()

    ole32, user32 = _get_win32_apis()
    ole32.CoInitialize(None)
    hwnd = user32.CreateWindowExW(0, "STATIC", "BPAsioWorker", 0, 0, 0, 0, 0, None, None, None, None)
    ptr = ctypes.c_void_p()
    started = False
    buffers_created = False
    pcm_out_q = queue.Queue(maxsize=64)

    try:
        clsid = _guid(clsid_str)
        hr = ole32.CoCreateInstance(ctypes.byref(clsid), None, 1, ctypes.byref(clsid), ctypes.byref(ptr))
        if hr != 0 or not ptr.value:
            raise RuntimeError(f"COM ASIO CoCreateInstance failed ({hex(hr & 0xFFFFFFFF)})")

        vtbl = ctypes.cast(ctypes.cast(ptr, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        init_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p)(vtbl[3])
        get_err_fn = ctypes.WINFUNCTYPE(None, ctypes.c_void_p, ctypes.c_char_p)(vtbl[6])
        start_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)(vtbl[7])
        stop_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)(vtbl[8])
        ch_fn = ctypes.WINFUNCTYPE(
            ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int32), ctypes.POINTER(ctypes.c_int32)
        )(vtbl[9])
        bufsz_fn = ctypes.WINFUNCTYPE(
            ctypes.c_int32,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int32),
            ctypes.POINTER(ctypes.c_int32),
            ctypes.POINTER(ctypes.c_int32),
            ctypes.POINTER(ctypes.c_int32),
        )(vtbl[11])
        can_sr_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_double)(vtbl[12])
        set_sr_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_double)(vtbl[14])
        info_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(_ASIOChannelInfo))(vtbl[18])
        create_bufs_fn = ctypes.WINFUNCTYPE(
            ctypes.c_int32, ctypes.c_void_p, ctypes.POINTER(_ASIOBufferInfo), ctypes.c_int32, ctypes.c_int32, ctypes.POINTER(_ASIOCallbacks)
        )(vtbl[19])
        dispose_bufs_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)(vtbl[20])
        panel_fn = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p)(vtbl[21])

        if not init_fn(ptr, hwnd):
            ebuf = ctypes.create_string_buffer(128)
            try:
                get_err_fn(ptr, ebuf)
            except Exception:
                pass
            detail = ebuf.value.decode("latin1", errors="ignore").strip()
            suffix = f" ({detail})" if detail else ""
            raise RuntimeError(f"ASIO driver init failed for {drv_name}{suffix}")

        if can_sr_fn(ptr, float(requested_rate)) == 0:
            set_sr_fn(ptr, float(requested_rate))

        nin, nout = ctypes.c_int32(), ctypes.c_int32()
        ch_fn(ptr, ctypes.byref(nin), ctypes.byref(nout))
        num_in = min(max(1, int(max_channels or 2)), max(1, int(nin.value)))

        mn, mx, pref, gran = ctypes.c_int32(), ctypes.c_int32(), ctypes.c_int32(), ctypes.c_int32()
        bufsz_fn(ptr, ctypes.byref(mn), ctypes.byref(mx), ctypes.byref(pref), ctypes.byref(gran))
        buf_size = int(pref.value) if pref.value > 0 else 512

        sample_types = []
        buf_infos = (_ASIOBufferInfo * num_in)()
        for ch in range(num_in):
            ci = _ASIOChannelInfo(channel=ch, isInput=1)
            info_fn(ptr, ctypes.byref(ci))
            sample_types.append(int(ci.type))
            buf_infos[ch].isInput = 1
            buf_infos[ch].channelNum = ch

        def _on_switch(double_buf_idx, _direct):
            if local_stop_evt.is_set() or not buffers_created:
                return
            idx = 1 if double_buf_idx else 0
            ch_arrays = [
                _decode_asio_channel(buf_infos[c].buffers[idx], buf_size, sample_types[c])
                for c in range(num_in)
            ]
            payload = b"".join(struct.pack(f"<{buf_size}f", *ch_arr) for ch_arr in ch_arrays)
            frame = b"BPCH" + struct.pack("<II", num_in, buf_size) + payload
            try:
                pcm_out_q.put_nowait(frame)
            except queue.Full:
                pass

        def _on_sr(_srate):
            pass

        def _on_msg(selector, value, _msg, _opt):
            if selector == 1:
                return 1 if value in (1, 2, 3, 7) else 0
            if selector == 2:
                return 2
            return 0

        def _on_switch_time(_params, double_buf_idx, direct):
            _on_switch(double_buf_idx, direct)
            return None

        cb_switch = ctypes.CFUNCTYPE(None, ctypes.c_int32, ctypes.c_int32)(_on_switch)
        cb_sr = ctypes.CFUNCTYPE(None, ctypes.c_double)(_on_sr)
        cb_msg = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_int32, ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p)(_on_msg)
        cb_time = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int32, ctypes.c_int32)(_on_switch_time)
        callbacks = _ASIOCallbacks(
            bufferSwitch=ctypes.cast(cb_switch, ctypes.c_void_p).value,
            sampleRateDidChange=ctypes.cast(cb_sr, ctypes.c_void_p).value,
            asioMessage=ctypes.cast(cb_msg, ctypes.c_void_p).value,
            bufferSwitchTimeInfo=ctypes.cast(cb_time, ctypes.c_void_p).value,
        )

        if create_bufs_fn(ptr, buf_infos, num_in, buf_size, ctypes.byref(callbacks)) != 0:
            raise RuntimeError("ASIO createBuffers failed")
        buffers_created = True
        if start_fn(ptr) != 0:
            raise RuntimeError("ASIO start() failed")
        started = True
        send_status({"ok": True, "channels": num_in, "bufSize": buf_size})

        msg = wintypes.MSG()
        while not local_stop_evt.is_set():
            if local_panel_evt.is_set():
                local_panel_evt.clear()
                try:
                    panel_fn(ptr)
                except Exception:
                    pass
            while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            flushed = False
            while not local_stop_evt.is_set():
                try:
                    pkt = pcm_out_q.get_nowait()
                    out_bin.write(pkt)
                    flushed = True
                except queue.Empty:
                    break
            if flushed:
                out_bin.flush()
            else:
                time.sleep(0.003)

        if started:
            stop_fn(ptr)
            time.sleep(0.02)
        if buffers_created:
            dispose_bufs_fn(ptr)
        out_bin.flush()
    except Exception as exc:
        try:
            send_status({"ok": False, "error": str(exc)})
        except Exception:
            pass
    # Exit directly without calling vendor DLL IUnknown::Release/CoUninitialize, avoiding rthdasio64.dll 0xc0000374 heap faults
    os._exit(0)


def _start_asio_com_capture(
    device_info, requested_rate, pcm_queue, stats, routing_state, stop_event, panel_event, level_tracker=None, raw_mc_queue=None, raw_mc_state=None
):
    """Starts isolated child-process 64-bit COM IASIO audio capture."""
    clsid_str = device_info.get("clsid")
    channels = int(device_info.get("maxInputChannels", 2))
    ready_evt = threading.Event()
    err_holder = [None]
    script_path = os.path.abspath(__file__)
    no_win = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    def _worker():
        proc = None
        try:
            proc = subprocess.Popen(
                [
                    sys.executable,
                    "-u",
                    script_path,
                    "--asio-capture-worker",
                    str(device_info.get("name", "ASIO")),
                    str(clsid_str or ""),
                    str(int(requested_rate or DEFAULT_RATE)),
                    str(max(1, channels)),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=no_win,
            )

            def _ctrl_pump():
                while not stop_event.is_set() and proc.poll() is None:
                    if panel_event.is_set():
                        panel_event.clear()
                        try:
                            if proc.stdin:
                                proc.stdin.write(b"panel\n")
                                proc.stdin.flush()
                        except Exception:
                            pass
                    time.sleep(0.02)
                if proc.poll() is None:
                    try:
                        if proc.stdin:
                            proc.stdin.write(b"stop\n")
                            proc.stdin.flush()
                            proc.stdin.close()
                    except Exception:
                        pass
                    try:
                        proc.wait(timeout=0.6)
                    except subprocess.TimeoutExpired:
                        try:
                            proc.kill()
                        except Exception:
                            pass

            threading.Thread(target=_ctrl_pump, daemon=True).start()

            while not stop_event.is_set():
                magic = _read_exact(proc.stdout, 4)
                if magic is None:
                    if not ready_evt.is_set():
                        err_txt = ""
                        try:
                            err_txt = (proc.stderr.read() or b"").decode("utf-8", errors="ignore").strip()
                        except Exception:
                            pass
                        msg = err_txt or f"ASIO worker exited before ready ({device_info.get('name')})"
                        err_holder[0] = msg
                        stats["warning"] = msg
                        ready_evt.set()
                    elif not stop_event.is_set():
                        stats["disconnected"] = True
                        stats["warning"] = f"ASIO driver disconnected ({device_info.get('name')})"
                    break
                if magic == b"BPST":
                    ln_raw = _read_exact(proc.stdout, 4)
                    if ln_raw is None:
                        break
                    ln = struct.unpack("<I", ln_raw)[0]
                    meta_raw = _read_exact(proc.stdout, ln)
                    if meta_raw is None:
                        break
                    meta = json.loads(meta_raw.decode("utf-8", errors="replace"))
                    if not meta.get("ok"):
                        msg = str(meta.get("error") or f"ASIO driver failed for {device_info.get('name')}")
                        err_holder[0] = msg
                        stats["warning"] = msg
                        ready_evt.set()
                        break
                    ready_evt.set()
                elif magic == b"BPCH":
                    hdr_raw = _read_exact(proc.stdout, 8)
                    if hdr_raw is None:
                        break
                    num_in, nf = struct.unpack("<II", hdr_raw)
                    payload_bytes = num_in * nf * 4
                    raw_floats = _read_exact(proc.stdout, payload_bytes)
                    if raw_floats is None:
                        break
                    ch_arrays = [
                        list(struct.unpack_from(f"<{nf}f", raw_floats, c * nf * 4))
                        for c in range(num_in)
                    ]
                    _push_audio_frame_block(
                        ch_arrays,
                        nf,
                        routing_state,
                        pcm_queue,
                        stats,
                        level_tracker=level_tracker,
                        raw_mc_queue=raw_mc_queue,
                        raw_mc_state=raw_mc_state,
                    )
                else:
                    break
        except Exception as exc:
            err_holder[0] = str(exc)
            stats["warning"] = str(exc)
            ready_evt.set()
        finally:
            stop_event.set()
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=0.5)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    ready_evt.wait(timeout=5.0)
    return t, err_holder[0]


def _start_winmm_capture(
    device_index,
    sample_rate,
    channels,
    blocksize,
    pcm_queue,
    stats,
    routing_state,
    stop_event,
    level_tracker=None,
    raw_mc_queue=None,
    raw_mc_state=None,
):
    """Background thread streaming PCM via Windows waveIn API when exclusive backends are unavailable."""
    class WAVEFORMATEX(ctypes.Structure):
        _fields_ = [
            ("wFormatTag", wintypes.WORD),
            ("nChannels", wintypes.WORD),
            ("nSamplesPerSec", wintypes.DWORD),
            ("nAvgBytesPerSec", wintypes.DWORD),
            ("nBlockAlign", wintypes.WORD),
            ("wBitsPerSample", wintypes.WORD),
            ("cbSize", wintypes.WORD),
        ]

    class WAVEHDR(ctypes.Structure):
        _fields_ = [
            ("lpData", ctypes.c_char_p),
            ("dwBufferLength", wintypes.DWORD),
            ("dwBytesRecorded", wintypes.DWORD),
            ("dwUser", ctypes.c_size_t),
            ("dwFlags", wintypes.DWORD),
            ("dwLoops", wintypes.DWORD),
            ("lpNext", ctypes.c_void_p),
            ("reserved", ctypes.c_size_t),
        ]

    winmm = ctypes.windll.winmm
    block_align = channels * 2
    wfx = WAVEFORMATEX(
        wFormatTag=1,
        nChannels=channels,
        nSamplesPerSec=sample_rate,
        nAvgBytesPerSec=sample_rate * block_align,
        nBlockAlign=block_align,
        wBitsPerSample=16,
        cbSize=0,
    )
    hwi = ctypes.c_void_p()
    rc = winmm.waveInOpen(ctypes.byref(hwi), int(device_index), ctypes.byref(wfx), 0, 0, 0)
    if rc != 0:
        raise RuntimeError(f"waveInOpen failed with error code {rc}")

    buf_bytes = blocksize * block_align
    buf_count = 4
    buffers = [ctypes.create_string_buffer(buf_bytes) for _ in range(buf_count)]
    headers = []
    for buf in buffers:
        hdr = WAVEHDR(lpData=ctypes.cast(buf, ctypes.c_char_p), dwBufferLength=buf_bytes)
        winmm.waveInPrepareHeader(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
        winmm.waveInAddBuffer(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
        headers.append((hdr, buf))

    winmm.waveInStart(hwi)
    WHDR_DONE = 0x00000001

    def _worker():
        idx = 0
        try:
            while not stop_event.is_set():
                hdr, buf = headers[idx]
                if not (hdr.dwFlags & WHDR_DONE):
                    time.sleep(0.004)
                    continue
                rec_bytes = hdr.dwBytesRecorded
                sample_pairs = rec_bytes // block_align
                if sample_pairs > 0:
                    raw = buf.raw[: sample_pairs * block_align]
                    ch_arrays = _decode_interleaved_pcm(raw, sample_pairs, channels, 16, is_float=False)
                    _push_audio_frame_block(
                        ch_arrays,
                        sample_pairs,
                        routing_state,
                        pcm_queue,
                        stats,
                        level_tracker=level_tracker,
                        raw_mc_queue=raw_mc_queue,
                        raw_mc_state=raw_mc_state,
                    )
                winmm.waveInUnprepareHeader(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
                hdr.dwFlags = 0
                hdr.dwBytesRecorded = 0
                winmm.waveInPrepareHeader(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
                winmm.waveInAddBuffer(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
                idx = (idx + 1) % buf_count
        finally:
            try:
                winmm.waveInStop(hwi)
                winmm.waveInReset(hwi)
                for hdr, _ in headers:
                    winmm.waveInUnprepareHeader(hwi, ctypes.byref(hdr), ctypes.sizeof(hdr))
                winmm.waveInClose(hwi)
            except Exception:
                pass

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    return t


class _ActiveCaptureController:
    """Manages active hardware capture lifecycle so UI can switch devices, enter Standby, and handle hot-plug."""

    def __init__(
        self,
        devices,
        selected,
        requested_rate,
        blocksize,
        pcm_queue,
        stats,
        routing_state,
        level_tracker=None,
        raw_mc_queue=None,
        raw_mc_state=None,
    ):
        self.devices = devices
        self.selected = selected
        self.requested_rate = requested_rate
        self.blocksize = blocksize
        self.pcm_queue = pcm_queue
        self.stats = stats
        self.routing_state = routing_state
        n_ch = int(selected.get("maxInputChannels", 2)) if selected else 0
        self.level_tracker = level_tracker or _RawPinLevelTracker(n_ch)
        self.raw_mc_queue = raw_mc_queue
        self.raw_mc_state = raw_mc_state
        self._lock = threading.RLock()
        self.thr_stop = threading.Event()
        self.panel_evt = threading.Event()
        self.sd_stream = None
        self.thread = None

    def start(self):
        with self._lock:
            self.stop()
            self.thr_stop = threading.Event()
            self.panel_evt = threading.Event()
            self.stats["warning"] = None
            self.stats["disconnected"] = False
            dev = self.selected
            if dev is None:
                self.level_tracker.reset(0)
                return
            self.level_tracker.reset(int(dev.get("maxInputChannels", 2)))
            backend = dev.get("backend")

            if backend == "sounddevice":
                import sounddevice as sd
                import numpy as np

                ch_count = max(1, int(dev.get("maxInputChannels", 2)))
                rate = int(dev.get("defaultSampleRate") or self.requested_rate)

                def audio_callback(indata, frames, _time_info, status):
                    if status and (status.input_overflow or status.input_underflow):
                        self.stats["xruns"] += 1
                    ch_arrays = [np.ascontiguousarray(indata[:, c], dtype=np.float32).tolist() for c in range(ch_count)]
                    _push_audio_frame_block(
                        ch_arrays,
                        frames,
                        self.routing_state,
                        self.pcm_queue,
                        self.stats,
                        level_tracker=self.level_tracker,
                        raw_mc_queue=self.raw_mc_queue,
                        raw_mc_state=self.raw_mc_state,
                    )

                self.sd_stream = sd.InputStream(
                    device=dev["index"],
                    channels=ch_count,
                    samplerate=rate,
                    blocksize=self.blocksize,
                    dtype="float32",
                    callback=audio_callback,
                )
                self.sd_stream.start()
                return

            if backend == "wasapi_exclusive":
                thr, err = _start_wasapi_exclusive_capture(
                    dev,
                    self.blocksize,
                    self.pcm_queue,
                    self.stats,
                    self.routing_state,
                    self.thr_stop,
                    self.level_tracker,
                    raw_mc_queue=self.raw_mc_queue,
                    raw_mc_state=self.raw_mc_state,
                )
                self.thread = thr
                if err:
                    print(f"[BhajanPlanner Audio Bridge] WARNING: {err}", file=sys.stderr)
                return

            if backend == "asio_com":
                thr, err = _start_asio_com_capture(
                    dev,
                    self.requested_rate,
                    self.pcm_queue,
                    self.stats,
                    self.routing_state,
                    self.thr_stop,
                    self.panel_evt,
                    self.level_tracker,
                    raw_mc_queue=self.raw_mc_queue,
                    raw_mc_state=self.raw_mc_state,
                )
                self.thread = thr
                if err:
                    print(f"[BhajanPlanner Audio Bridge] WARNING: {err}", file=sys.stderr)
                return

            ch_count = min(2, max(1, int(dev.get("maxInputChannels", 2))))
            self.thread = _start_winmm_capture(
                dev["index"],
                int(dev.get("defaultSampleRate") or self.requested_rate),
                ch_count,
                self.blocksize,
                self.pcm_queue,
                self.stats,
                self.routing_state,
                self.thr_stop,
                self.level_tracker,
                raw_mc_queue=self.raw_mc_queue,
                raw_mc_state=self.raw_mc_state,
            )

    def switch_device(self, device_id):
        with self._lock:
            needle = str(device_id if device_id is not None else "").strip().lower()
            if needle in ("none", "standby", "off", ""):
                self.selected = None
                self.routing_state["ch1"] = "none"
                self.routing_state["ch2"] = "none"
                self.stop()
                self.level_tracker.reset(0)
                print("[BhajanPlanner Audio Bridge] Switched to Standby (no hardware input active)")
                return True
            match = next(
                (d for d in self.devices if str(d.get("id")) == str(device_id) or str(d.get("name")) == str(device_id)),
                None,
            )
            if not match:
                return False
            self.selected = match
            n_ch = int(match.get("maxInputChannels", 2))
            self.routing_state["ch1"] = "0"
            self.routing_state["ch2"] = "1" if n_ch >= 2 else "none"
            print(
                f"[BhajanPlanner Audio Bridge] Switching to [{match.get('id')}] {match['name']} "
                f"({match.get('hostApi')}) @ {match.get('defaultSampleRate', self.requested_rate)} Hz, {n_ch} ch"
            )
            self.start()
            return True

    def refresh_devices(self, prefer_external=True, include_loopback=False):
        new_devices = list_audio_devices(include_loopback=include_loopback)
        with self._lock:
            old_sig = [(d.get("id"), d.get("name"), d.get("deviceCategory")) for d in self.devices]
            new_sig = [(d.get("id"), d.get("name"), d.get("deviceCategory")) for d in new_devices]
            dev_list_changed = old_sig != new_sig
            self.devices = new_devices
            cur = self.selected
            cur_id = str(cur.get("id", "")) if cur else ""
            cur_cat = cur.get("deviceCategory", "") if cur else ""
            ext_candidate = resolve_device_index(new_devices, "", allow_onboard_fallback=False)
            same_dev = (
                next(
                    (d for d in new_devices if str(d.get("id", "")) == cur_id and d.get("name") == cur.get("name")),
                    None,
                )
                if cur is not None
                else None
            )
            if self.stats.get("disconnected"):
                same_dev = None
            if cur is None:
                if prefer_external and ext_candidate is not None:
                    return self.switch_device(ext_candidate.get("id")), dev_list_changed
                return False, dev_list_changed
            if prefer_external and cur_cat != "external_interface" and ext_candidate is not None:
                return self.switch_device(ext_candidate.get("id")), dev_list_changed
            if same_dev is not None:
                self.selected = same_dev
                return False, dev_list_changed
            if ext_candidate is not None:
                return self.switch_device(ext_candidate.get("id")), dev_list_changed
            return self.switch_device("none"), dev_list_changed

    def open_asio_panel(self):
        with self._lock:
            if self.selected and self.selected.get("backend") == "asio_com":
                self.panel_evt.set()
                return True
            return False

    def stop(self):
        with self._lock:
            self.thr_stop.set()
            if self.sd_stream is not None:
                try:
                    self.sd_stream.stop()
                    self.sd_stream.close()
                except Exception:
                    pass
                self.sd_stream = None
            if self.thread is not None and self.thread.is_alive():
                self.thread.join(timeout=1.0)
                self.thread = None


async def run_bridge(host, port, device_query, sample_rate, blocksize, allow_onboard=False, include_loopback=False):
    devices = list_audio_devices(include_loopback=include_loopback)
    selected = resolve_device_index(devices, device_query, allow_onboard_fallback=allow_onboard)

    asio_drivers = enumerate_windows_asio_registry()
    pcm_queue = queue.Queue(maxsize=96)
    raw_mc_queue = queue.Queue(maxsize=96)
    raw_mc_state = {"enabled": False}
    stats = {"xruns": 0, "droppedFrames": 0, "disconnected": False, "warning": None}
    routing_state = {
        "ch1": "0" if selected else "none",
        "ch2": "1" if (selected and int(selected.get("maxInputChannels", 1)) >= 2) else "none",
    }
    level_tracker = _RawPinLevelTracker(int(selected.get("maxInputChannels", 2)) if selected else 0)
    controller = _ActiveCaptureController(
        devices,
        selected,
        sample_rate,
        blocksize,
        pcm_queue,
        stats,
        routing_state,
        level_tracker=level_tracker,
        raw_mc_queue=raw_mc_queue,
        raw_mc_state=raw_mc_state,
    )
    stop_event = asyncio.Event()
    refresh_lock = asyncio.Lock()

    def build_hello():
        cur = controller.selected
        ext_connected = any(d.get("deviceCategory") == "external_interface" for d in controller.devices)
        if cur is None:
            return json.dumps(
                {
                    "type": "bridge-info",
                    "standby": True,
                    "externalInterfaceConnected": ext_connected,
                    "allowOnboard": bool(allow_onboard),
                    "activeDevice": None,
                    "deviceId": "",
                    "deviceCategory": "standby",
                    "deviceName": "No External Interface (Standby)",
                    "cleanName": "No External Interface (Standby)",
                    "hostApi": "Standby",
                    "isAsio": False,
                    "isExclusive": False,
                    "registeredAsioDrivers": asio_drivers,
                    "devices": controller.devices,
                    "sampleRate": sample_rate,
                    "channels": 0,
                    "inputChannels": [],
                    "routing": {"ch1": "none", "ch2": "none"},
                    "blocksize": blocksize,
                    "warning": stats.get("warning"),
                    "protocol": "BPAS-v1",
                }
            )
        ch_count = max(1, int(cur.get("maxInputChannels", 2)))
        return json.dumps(
            {
                "type": "bridge-info",
                "standby": False,
                "externalInterfaceConnected": ext_connected,
                "allowOnboard": bool(allow_onboard),
                "activeDevice": cur,
                "deviceId": cur.get("id"),
                "deviceCategory": cur.get("deviceCategory", "onboard"),
                "deviceName": cur["name"],
                "cleanName": cur.get("cleanName") or clean_hardware_name(cur["name"]),
                "hostApi": cur["hostApi"],
                "isAsio": bool(cur.get("isAsio")),
                "isExclusive": bool(cur.get("isExclusive")),
                "registeredAsioDrivers": asio_drivers,
                "devices": controller.devices,
                "sampleRate": int(cur.get("defaultSampleRate") or sample_rate),
                "channels": ch_count,
                "inputChannels": cur.get("channelsCatalog")
                or build_audition_channel_catalog(cur["name"], ch_count, cur.get("pinNames")),
                "routing": {"ch1": routing_state["ch1"], "ch2": routing_state["ch2"]},
                "blocksize": blocksize,
                "warning": stats.get("warning"),
                "protocol": "BPAS-v1",
            }
        )

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    clients = set()
    monitor_only_clients = set()
    multichannel_clients = set()

    def _discard_client(c):
        clients.discard(c)
        monitor_only_clients.discard(c)
        multichannel_clients.discard(c)
        raw_mc_state["enabled"] = len(multichannel_clients) > 0

    async def send_text_to_client(client, text_msg):
        if hasattr(client, "send_text"):
            await client.send_text(text_msg)
        else:
            await client.send(text_msg)

    async def send_binary_to_client(client, payload):
        if hasattr(client, "send_binary"):
            await client.send_binary(payload)
        else:
            await client.send(payload)

    async def broadcast_hello():
        msg = build_hello()
        for c in list(clients):
            try:
                await send_text_to_client(c, msg)
            except Exception:
                _discard_client(c)

    async def handle_client_command(client, raw_text):
        try:
            cmd = json.loads(raw_text)
        except Exception:
            return
        if not isinstance(cmd, dict):
            return
        ctype = cmd.get("type")
        if ctype == "ping":
            await send_text_to_client(client, json.dumps({"type": "pong", **stats}))
        elif ctype == "set-client-mode":
            if str(cmd.get("mode", "")).lower() == "monitor":
                monitor_only_clients.add(client)
            else:
                monitor_only_clients.discard(client)
        elif ctype == "set-multichannel-tap":
            if cmd.get("enabled"):
                multichannel_clients.add(client)
            else:
                multichannel_clients.discard(client)
            raw_mc_state["enabled"] = len(multichannel_clients) > 0
        elif ctype == "set-routing":
            if "ch1" in cmd and cmd["ch1"] is not None:
                routing_state["ch1"] = str(cmd["ch1"])
            if "ch2" in cmd and cmd["ch2"] is not None:
                routing_state["ch2"] = str(cmd["ch2"])
            await broadcast_hello()
        elif ctype == "select-device":
            if "deviceId" in cmd or "device" in cmd:
                dev_id = cmd.get("deviceId") if cmd.get("deviceId") is not None else cmd.get("device")
                async with refresh_lock:
                    switched = await asyncio.to_thread(controller.switch_device, dev_id)
                if switched:
                    await broadcast_hello()
        elif ctype == "refresh-devices":
            nonlocal devices, asio_drivers
            async with refresh_lock:
                await asyncio.to_thread(controller.refresh_devices, True, include_loopback)
                devices = controller.devices
                asio_drivers = enumerate_windows_asio_registry()
            await broadcast_hello()
        elif ctype == "open-asio-panel":
            opened = controller.open_asio_panel()
            await send_text_to_client(
                client,
                json.dumps(
                    {
                        "type": "asio-panel-status",
                        "opened": opened,
                        "message": "Opened ASIO driver control panel."
                        if opened
                        else "Driver panel only applies when an ASIO driver is active.",
                    }
                ),
            )

    async def broadcast_loop():
        while not stop_event.is_set():
            did_work = False
            try:
                pkt = pcm_queue.get_nowait()
                did_work = True
                audio_clients = [c for c in list(clients) if c not in monitor_only_clients]
                if audio_clients:
                    for c in audio_clients:
                        try:
                            await send_binary_to_client(c, pkt)
                        except Exception:
                            _discard_client(c)
            except queue.Empty:
                pass
            try:
                mc_pkt = raw_mc_queue.get_nowait()
                did_work = True
                mc_targets = [c for c in list(multichannel_clients) if c in clients]
                if mc_targets:
                    for c in mc_targets:
                        try:
                            await send_binary_to_client(c, mc_pkt)
                        except Exception:
                            _discard_client(c)
            except queue.Empty:
                pass
            if not did_work:
                await asyncio.sleep(0.004)

    async def telemetry_loop():
        while not stop_event.is_set():
            await asyncio.sleep(0.10)
            if not clients:
                continue
            cur = controller.selected
            if cur is None:
                payload = json.dumps(
                    {
                        "type": "input-levels",
                        "standby": True,
                        "deviceId": "",
                        "cleanName": "No External Interface (Standby)",
                        "hostApi": "Standby",
                        "channels": 0,
                        "peaksDb": [],
                        "rmsDb": [],
                        "noiseFloorsDb": [],
                        "snrDb": [],
                        "activePins": [],
                        "corr01": 0.0,
                        "duplicatedMono": False,
                        "routing": {"ch1": "none", "ch2": "none"},
                    }
                )
            else:
                levels = level_tracker.flush()
                payload = json.dumps(
                    {
                        "type": "input-levels",
                        "standby": False,
                        "deviceId": cur.get("id"),
                        "cleanName": cur.get("cleanName") or clean_hardware_name(cur["name"]),
                        "hostApi": cur.get("hostApi"),
                        "channels": levels["channels"],
                        "peaksDb": levels["peaksDb"],
                        "rmsDb": levels["rmsDb"],
                        "noiseFloorsDb": levels["noiseFloorsDb"],
                        "snrDb": levels["snrDb"],
                        "activePins": levels["activePins"],
                        "corr01": levels["corr01"],
                        "duplicatedMono": levels["duplicatedMono"],
                        "routing": {"ch1": routing_state["ch1"], "ch2": routing_state["ch2"]},
                    }
                )
            for c in list(clients):
                try:
                    await send_text_to_client(c, payload)
                except Exception:
                    _discard_client(c)

    async def hotplug_loop():
        nonlocal devices, asio_drivers
        prev_ids = _get_active_capture_endpoint_ids()
        while not stop_event.is_set():
            await asyncio.sleep(1.5)
            try:
                cur_ids = await asyncio.to_thread(_get_active_capture_endpoint_ids)
            except Exception:
                cur_ids = prev_ids
            if cur_ids != prev_ids or stats.get("disconnected"):
                prev_ids = cur_ids
                async with refresh_lock:
                    sel_changed, list_changed = await asyncio.to_thread(
                        controller.refresh_devices, True, include_loopback
                    )
                    devices = controller.devices
                    asio_drivers = enumerate_windows_asio_registry()
                if sel_changed or list_changed:
                    await broadcast_hello()

    async def serve_websockets():
        try:
            import websockets

            async def ws_handler(ws, path=""):
                req_target = str(getattr(getattr(ws, "request", None), "path", path) or path or "")
                clients.add(ws)
                if "mode=monitor" in req_target.lower():
                    monitor_only_clients.add(ws)
                await ws.send(build_hello())
                try:
                    async for raw in ws:
                        await handle_client_command(ws, raw)
                finally:
                    _discard_client(ws)

            async with websockets.serve(ws_handler, host, port, max_size=2 * 1024 * 1024):
                await stop_event.wait()
        except ImportError:
            async def stdlib_handler(reader, writer):
                client = None
                try:
                    req = b""
                    while b"\r\n\r\n" not in req and len(req) < 8192:
                        chunk = await reader.read(1024)
                        if not chunk:
                            writer.close()
                            return
                        req += chunk
                    req_text = req.decode("utf-8", errors="ignore")
                    req_lines = req_text.split("\r\n")
                    first_line = req_lines[0] if req_lines else ""
                    key_line = [
                        line.split(":", 1)[1].strip()
                        for line in req_lines
                        if line.lower().startswith("sec-websocket-key:")
                    ]
                    if not key_line:
                        writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                        await writer.drain()
                        writer.close()
                        return
                    accept = base64.b64encode(
                        hashlib.sha1((key_line[0] + WS_GUID).encode("utf-8")).digest()
                    ).decode("ascii")
                    writer.write(
                        (
                            "HTTP/1.1 101 Switching Protocols\r\n"
                            "Upgrade: websocket\r\n"
                            "Connection: Upgrade\r\n"
                            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                        ).encode("ascii")
                    )
                    await writer.drain()
                    client = StdlibWsClient(reader, writer)
                    clients.add(client)
                    if "mode=monitor" in first_line.lower():
                        monitor_only_clients.add(client)
                    await client.send_text(build_hello())
                    while not client.closed and not stop_event.is_set():
                        msg = await client.read_message()
                        if msg is None:
                            break
                        if msg:
                            await handle_client_command(client, msg)
                except Exception:
                    pass
                finally:
                    if client is not None:
                        client.close()
                        _discard_client(client)
                    for c in list(clients):
                        if getattr(c, "writer", None) is writer:
                            c.close()
                            _discard_client(c)

            srv = await asyncio.start_server(stdlib_handler, host, port)
            async with srv:
                await stop_event.wait()

    controller.start()
    if selected is not None:
        print(
            f"[BhajanPlanner Audio Bridge] Opening [{selected.get('id')}] {selected['name']} "
            f"({selected['hostApi']}) @ {selected.get('defaultSampleRate', sample_rate)} Hz, {selected['maxInputChannels']} ch"
        )
    else:
        print(
            "[BhajanPlanner Audio Bridge] Standby: no external audio interface detected. "
            "Plug in a USB/ASIO interface or select an input manually in Studio UI."
        )
    print(f"[BhajanPlanner Audio Bridge] WebSocket listening on ws://{host}:{port}")

    bcast_task = asyncio.create_task(broadcast_loop())
    telemetry_task = asyncio.create_task(telemetry_loop())
    hotplug_task = asyncio.create_task(hotplug_loop())
    try:
        await serve_websockets()
    finally:
        stop_event.set()
        bcast_task.cancel()
        telemetry_task.cancel()
        hotplug_task.cancel()
        controller.stop()


def main():
    parser = argparse.ArgumentParser(
        description="Bhajan Planner Local Native Audio Bridge (WASAPI Exclusive / ASIO / WinMM)"
    )
    parser.add_argument("--list", "--list-devices", dest="list_devices", action="store_true", help="List available input devices and exit")
    parser.add_argument("--device", default="", help="Substring or deviceId of ASIO/WASAPI/USB device")
    parser.add_argument("--allow-onboard", action="store_true", help="Allow fallback to built-in audio if no external interface is connected")
    parser.add_argument("--include-loopback", action="store_true", help="Include loopback / Stereo Mix devices in listing")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--rate", type=int, default=DEFAULT_RATE)
    parser.add_argument("--blocksize", type=int, default=DEFAULT_BLOCKSIZE)
    parser.add_argument("--asio-probe-single", nargs=2, metavar=("NAME", "CLSID"), help=argparse.SUPPRESS)
    parser.add_argument(
        "--asio-capture-worker",
        nargs=4,
        metavar=("NAME", "CLSID", "RATE", "CHANNELS"),
        help=argparse.SUPPRESS,
    )
    args = parser.parse_args()

    if args.asio_probe_single:
        _run_asio_probe_worker(args.asio_probe_single[0], args.asio_probe_single[1])
        return

    if args.asio_capture_worker:
        _run_asio_capture_worker(
            args.asio_capture_worker[0],
            args.asio_capture_worker[1],
            int(args.asio_capture_worker[2]),
            int(args.asio_capture_worker[3]),
        )
        return

    if args.list_devices:
        print(
            json.dumps(
                {
                    "python": sys.version.split()[0],
                    "registeredAsioDrivers": enumerate_windows_asio_registry(),
                    "inputDevices": list_audio_devices(include_loopback=args.include_loopback),
                },
                indent=2,
            )
        )
        return

    try:
        asyncio.run(
            run_bridge(
                args.host,
                args.port,
                args.device,
                args.rate,
                args.blocksize,
                allow_onboard=args.allow_onboard,
                include_loopback=args.include_loopback,
            )
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

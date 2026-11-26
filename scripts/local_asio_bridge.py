"""
Bhajan Planner Local Native ASIO / Windows Audio Bridge (Zero-Cost Companion)

Streams 2 independent mono channels (Ch1: Vocals, Ch2: Instruments) at 48 kHz
Float32 PCM over ws://127.0.0.1:17940 directly to the Bhajan Planner Live Studio
browser tab (`bp-asio-ingest` AudioWorklet), avoiding browser WASAPI stereo-sum limits
when using Behringer USB interfaces or ASIO4ALL on Windows.

Operation modes:
  1. Primary ASIO mode: Uses `sounddevice` (PortAudio ASIO/WASAPI-Exclusive) + `websockets` when installed.
  2. Zero-pip stdlib Windows mode: Automatically falls back to `winreg` (ASIO registry enumeration) +
     `ctypes.windll.winmm` (2-ch 48 kHz Windows WaveIn) + pure stdlib `asyncio` WebSocket server
     so the bridge launches cleanly on stock Python 3.13 without third-party packages.

Optional upgrade for true low-latency ASIO routing:
    pip install sounddevice websockets numpy
"""

import argparse
import asyncio
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import queue
import signal
import struct
import sys

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17940
DEFAULT_RATE = 48000
DEFAULT_BLOCKSIZE = 512

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


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
                try:
                    with winreg.OpenKey(key, sub_name) as sub:
                        desc, _ = winreg.QueryValueEx(sub, "Description")
                except OSError:
                    pass
                drivers.append({"name": sub_name, "description": desc})
    except OSError:
        pass
    return drivers


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

    winmm = ctypes.windll.winmm
    num_devs = int(winmm.waveInGetNumDevs())
    out = []
    for idx in range(num_devs):
        caps = WAVEINCAPSW()
        rc = winmm.waveInGetDevCapsW(idx, ctypes.byref(caps), ctypes.sizeof(caps))
        if rc == 0:
            ch = int(caps.wChannels)
            if ch <= 0 or ch > 32:
                ch = 2
            out.append(
                {
                    "index": idx,
                    "name": caps.szPname,
                    "hostApi": "Windows MME (winmm stdlib fallback)",
                    "isAsio": False,
                    "backend": "winmm",
                    "maxInputChannels": ch,
                    "defaultSampleRate": DEFAULT_RATE,
                }
            )
    return out


def list_audio_devices():
    try:
        import sounddevice as sd
    except ImportError:
        winmm_devs = _enumerate_winmm_devices()
        asio_regs = enumerate_windows_asio_registry()
        for d in winmm_devs:
            d["registeredAsioDrivers"] = [r["name"] for r in asio_regs]
        return winmm_devs

    host_apis = sd.query_hostapis()
    devices = sd.query_devices()
    out = []
    for idx, dev in enumerate(devices):
        if int(dev.get("max_input_channels", 0)) < 1:
            continue
        api_idx = int(dev.get("hostapi", 0))
        api_name = host_apis[api_idx]["name"] if api_idx < len(host_apis) else "Unknown"
        out.append(
            {
                "index": idx,
                "name": dev.get("name", f"Device {idx}"),
                "hostApi": api_name,
                "isAsio": "asio" in api_name.lower(),
                "backend": "sounddevice",
                "maxInputChannels": int(dev.get("max_input_channels", 0)),
                "defaultSampleRate": int(dev.get("default_samplerate", DEFAULT_RATE)),
            }
        )
    return out


def resolve_device_index(devices, requested_name):
    if requested_name:
        needle = requested_name.lower()
        asio_matches = [d for d in devices if needle in d["name"].lower() and d["isAsio"]]
        if asio_matches:
            return asio_matches[0]
        any_matches = [d for d in devices if needle in d["name"].lower()]
        if any_matches:
            return any_matches[0]

    for kw in ("behringer", "umc", "usb audio codec", "asio4all"):
        asio_auto = [d for d in devices if d["isAsio"] and kw in d["name"].lower()]
        if asio_auto:
            return asio_auto[0]

    asio_any = [d for d in devices if d["isAsio"] and d["maxInputChannels"] >= 2]
    if asio_any:
        return asio_any[0]

    for kw in ("behringer", "umc", "usb audio codec", "line"):
        usb_matches = [d for d in devices if kw in d["name"].lower() and d["maxInputChannels"] >= 2]
        if usb_matches:
            return usb_matches[0]

    stereo_any = [d for d in devices if d["maxInputChannels"] >= 2]
    return stereo_any[0] if stereo_any else (devices[0] if devices else None)


def pack_bpas_packet(ch1_floats, ch2_floats):
    frames = len(ch1_floats)
    header = struct.pack("<4sI", b"BPAS", frames)
    fmt = f"<{frames}f"
    payload1 = struct.pack(fmt, *ch1_floats)
    payload2 = struct.pack(fmt, *ch2_floats) if ch2_floats is not None else b""
    return header + payload1 + payload2


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
        if opcode == 0x8:  # close
            self.closed = True
            return None
        if opcode == 0x9:  # ping -> pong
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


def _start_winmm_capture(device_index, sample_rate, channels, blocksize, pcm_queue, stats, stop_event):
    """Background thread streaming PCM via Windows waveIn API when sounddevice is unavailable."""
    import threading

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
        wFormatTag=1,  # PCM
        nChannels=channels,
        nSamplesPerSec=sample_rate,
        nAvgBytesPerSec=sample_rate * block_align,
        nBlockAlign=block_align,
        wBitsPerSample=16,
        cbSize=0,
    )
    hwi = ctypes.c_void_p()
    rc = winmm.waveInOpen(ctypes.byref(hwi), device_index, ctypes.byref(wfx), 0, 0, 0)
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
                    import time
                    time.sleep(0.004)
                    continue
                rec_bytes = hdr.dwBytesRecorded
                raw = buf.raw[:rec_bytes]
                sample_pairs = rec_bytes // block_align
                if sample_pairs > 0:
                    shorts = struct.unpack(f"<{sample_pairs * channels}h", raw[: sample_pairs * block_align])
                    ch1 = [shorts[i * channels] / 32768.0 for i in range(sample_pairs)]
                    ch2 = (
                        [shorts[i * channels + 1] / 32768.0 for i in range(sample_pairs)]
                        if channels > 1
                        else [0.0] * sample_pairs
                    )
                    pkt = pack_bpas_packet(ch1, ch2)
                    try:
                        pcm_queue.put_nowait(pkt)
                    except queue.Full:
                        stats["droppedFrames"] += sample_pairs
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


async def run_bridge(host, port, device_query, sample_rate, blocksize):
    devices = list_audio_devices()
    if not devices:
        print("No audio input devices found.", file=sys.stderr)
        sys.exit(1)

    selected = resolve_device_index(devices, device_query)
    if not selected:
        print("Could not select an audio input device.", file=sys.stderr)
        sys.exit(1)

    channels_to_open = min(2, max(1, selected["maxInputChannels"]))
    asio_drivers = enumerate_windows_asio_registry()
    pcm_queue = queue.Queue(maxsize=96)
    stats = {"xruns": 0, "droppedFrames": 0, "disconnected": False}
    stop_event = asyncio.Event()

    def build_hello():
        return json.dumps(
            {
                "type": "bridge-info",
                "activeDevice": selected,
                "deviceName": selected["name"],
                "hostApi": selected["hostApi"],
                "isAsio": bool(selected.get("isAsio")),
                "registeredAsioDrivers": asio_drivers,
                "devices": devices,
                "sampleRate": sample_rate,
                "channels": channels_to_open,
                "blocksize": blocksize,
                "protocol": "BPAS-v1",
            }
        )

    use_sounddevice = False
    try:
        import sounddevice as sd
        import numpy as np
        use_sounddevice = True
    except ImportError:
        use_sounddevice = False

    print(
        f"[BhajanPlanner Audio Bridge] Opening [{selected['index']}] {selected['name']} "
        f"({selected['hostApi']}) @ {sample_rate} Hz, {channels_to_open} ch"
    )
    print(f"[BhajanPlanner Audio Bridge] WebSocket listening on ws://{host}:{port}")

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    clients = set()

    async def broadcast_loop():
        while not stop_event.is_set():
            try:
                pkt = pcm_queue.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.004)
                continue
            if clients:
                dead = []
                for c in list(clients):
                    try:
                        if hasattr(c, "send_binary"):
                            await c.send_binary(pkt)
                        else:
                            await c.send(pkt)
                    except Exception:
                        dead.append(c)
                for c in dead:
                    clients.discard(c)

    async def serve_websockets():
        try:
            import websockets

            async def ws_handler(ws):
                clients.add(ws)
                await ws.send(build_hello())
                try:
                    async for raw in ws:
                        try:
                            cmd = json.loads(raw)
                            if isinstance(cmd, dict) and cmd.get("type") == "ping":
                                await ws.send(json.dumps({"type": "pong", **stats}))
                        except Exception:
                            pass
                finally:
                    clients.discard(ws)

            async with websockets.serve(ws_handler, host, port, max_size=2 * 1024 * 1024):
                await stop_event.wait()
        except ImportError:
            async def stdlib_handler(reader, writer):
                try:
                    req = b""
                    while b"\r\n\r\n" not in req and len(req) < 8192:
                        chunk = await reader.read(1024)
                        if not chunk:
                            writer.close()
                            return
                        req += chunk
                    key_line = [
                        line.split(":", 1)[1].strip()
                        for line in req.decode("utf-8", errors="ignore").split("\r\n")
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
                    await client.send_text(build_hello())
                    while not client.closed and not stop_event.is_set():
                        msg = await client.read_message()
                        if msg is None:
                            break
                        if msg:
                            try:
                                cmd = json.loads(msg)
                                if isinstance(cmd, dict) and cmd.get("type") == "ping":
                                    await client.send_text(json.dumps({"type": "pong", **stats}))
                            except Exception:
                                pass
                except Exception:
                    pass
                finally:
                    for c in list(clients):
                        if getattr(c, "writer", None) is writer:
                            c.close()
                            clients.discard(c)

            srv = await asyncio.start_server(stdlib_handler, host, port)
            async with srv:
                await stop_event.wait()

    bcast_task = asyncio.create_task(broadcast_loop())
    try:
        if use_sounddevice:
            def audio_callback(indata, frames, _time_info, status):
                if status and (status.input_overflow or status.input_underflow):
                    stats["xruns"] += 1
                ch1 = np.ascontiguousarray(indata[:, 0], dtype=np.float32)
                ch2 = (
                    np.ascontiguousarray(indata[:, 1], dtype=np.float32)
                    if indata.shape[1] > 1
                    else np.zeros(frames, dtype=np.float32)
                )
                header = struct.pack("<4sI", b"BPAS", frames)
                payload = header + ch1.tobytes() + ch2.tobytes()
                try:
                    pcm_queue.put_nowait(payload)
                except queue.Full:
                    stats["droppedFrames"] += frames

            with sd.InputStream(
                device=selected["index"],
                channels=channels_to_open,
                samplerate=sample_rate,
                blocksize=blocksize,
                dtype="float32",
                callback=audio_callback,
            ):
                await serve_websockets()
        else:
            import threading
            thr_stop = threading.Event()
            _start_winmm_capture(selected["index"], sample_rate, channels_to_open, blocksize, pcm_queue, stats, thr_stop)
            try:
                await serve_websockets()
            finally:
                thr_stop.set()
    finally:
        stop_event.set()
        bcast_task.cancel()


def main():
    parser = argparse.ArgumentParser(
        description="Bhajan Planner Local ASIO / Windows Audio Bridge"
    )
    parser.add_argument("--list", "--list-devices", dest="list_devices", action="store_true", help="List available input devices and exit")
    parser.add_argument("--device", default="", help="Substring of ASIO/USB device name")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--rate", type=int, default=DEFAULT_RATE)
    parser.add_argument("--blocksize", type=int, default=DEFAULT_BLOCKSIZE)
    args = parser.parse_args()

    if args.list_devices:
        print(
            json.dumps(
                {
                    "python": sys.version.split()[0],
                    "registeredAsioDrivers": enumerate_windows_asio_registry(),
                    "inputDevices": list_audio_devices(),
                },
                indent=2,
            )
        )
        return

    try:
        asyncio.run(run_bridge(args.host, args.port, args.device, args.rate, args.blocksize))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

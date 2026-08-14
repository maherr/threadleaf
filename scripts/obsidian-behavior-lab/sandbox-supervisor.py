#!/usr/bin/env python3
"""Observe one synthetic Obsidian launch from inside its Flatpak sandbox.

This is a behavior-lab helper, not an application shim. It uses the public Flatpak
command declared by the installed application's metadata and only records bounded
process, network, accessibility, and surface observations for the synthetic run.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import posixpath
import stat
import socket
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any


MAX_READ_BYTES = 64 * 1024
MAX_TREE_FILE_BYTES = 64 * 1024 * 1024
MAX_PROCESSES = 512
MAX_AX_NODES = 256
MAX_VISIBLE_TEXT = 2400
MAX_CDP_FRAME_BYTES = 512 * 1024
MAX_CDP_HTTP_BYTES = 128 * 1024
MAX_CDP_EXPRESSION_BYTES = 16 * 1024
FIXTURE_PREDICATE = "THREADLEAF_OBSIDIAN_LAB_FIXTURE_V1"
FIXTURE_NOTE = "00 Overview.md"
SYNTHETIC_EDIT = "THREADLEAF_SYNTHETIC_EDIT_V1"
RESTRICTED_MODE_LABEL = "Browse vault in Restricted Mode"


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_bytes(path: str, limit: int = MAX_READ_BYTES) -> bytes:
    try:
        with open(path, "rb") as handle:
            return handle.read(limit + 1)
    except OSError:
        return b""


def read_text(path: str, limit: int = MAX_READ_BYTES) -> str:
    return read_bytes(path, limit).decode("utf-8", errors="replace")[:limit]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str, expected_size: int) -> str:
    if expected_size > MAX_TREE_FILE_BYTES:
        fail(f"captured tree file exceeds bounded hash size: {path}")
    digest = hashlib.sha256()
    counted = 0
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                counted += len(chunk)
                digest.update(chunk)
    except OSError as error:
        fail(f"cannot hash captured tree file {path}: {error}")
    if counted != expected_size:
        fail(f"captured tree file changed while hashing: {path}")
    return digest.hexdigest()


def tree_entries(root: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    def visit(current: str, relative: str) -> None:
        try:
            children = sorted(os.scandir(current), key=lambda child: child.name)
        except OSError as error:
            fail(f"cannot enumerate captured tree {current}: {error}")
        for child in children:
            child_relative = posixpath.join(relative, child.name) if relative else child.name
            child_relative = child_relative.replace(os.sep, "/")
            try:
                child_stat = child.stat(follow_symlinks=False)
            except OSError as error:
                fail(f"cannot stat captured tree entry {child_relative}: {error}")
            mode = stat.S_IMODE(child_stat.st_mode)
            if stat.S_ISDIR(child_stat.st_mode):
                entries.append({"kind": "directory", "path": child_relative, "bytes": 0, "mode": mode})
                visit(child.path, child_relative)
            elif stat.S_ISREG(child_stat.st_mode):
                entries.append(
                    {
                        "kind": "file",
                        "path": child_relative,
                        "bytes": child_stat.st_size,
                        "sha256": sha256_file(child.path, child_stat.st_size),
                        "mode": mode,
                    }
                )
            elif stat.S_ISLNK(child_stat.st_mode):
                target = os.readlink(child.path)
                resolved = os.path.realpath(child.path)
                inside_run_root = os.path.commonpath([resolved, os.path.realpath(root)]) == os.path.realpath(root)
                if not child_relative.startswith("Singleton") and not inside_run_root:
                    fail(f"captured tree symlink escaped the run root: {child_relative} -> {target}")
                entries.append(
                    {
                        "kind": "symlink",
                        "path": child_relative,
                        "bytes": len(target.encode("utf-8", errors="surrogateescape")),
                        "sha256": sha256_bytes(target.encode("utf-8", errors="surrogateescape")),
                        "target": target[:MAX_READ_BYTES],
                        "targetRealpath": resolved,
                        "targetInsideRunRoot": inside_run_root,
                        "mode": mode,
                    }
                )
            else:
                fail(f"captured tree contains unsupported entry: {child_relative}")
    visit(root, "")
    return entries


def tree_hash(entries: list[dict[str, Any]]) -> str:
    lines = "".join(
        f"{entry['kind']}\0{entry['path']}\0{entry['bytes']}\0"
        f"{entry.get('sha256', '')}\0{entry['mode']}\n"
        for entry in entries
    )
    return sha256_bytes(lines.encode("utf-8"))


def tree_snapshot(root: str) -> dict[str, Any]:
    real = os.path.realpath(root)
    entries = tree_entries(real)
    return {"realpath": real, "entries": entries, "treeSha256": tree_hash(entries)}


def process_start_time(pid: int) -> dict[str, Any]:
    raw = read_text(f"/proc/{pid}/stat")
    closing = raw.rfind(")")
    if closing < 0:
        return {}
    fields = raw[closing + 1 :].split()
    if len(fields) < 20:
        return {}
    ticks = int(fields[19])
    hz = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
    uptime_text = read_text("/proc/uptime").split()
    uptime = float(uptime_text[0]) if uptime_text else 0.0
    return {"clockTicks": ticks, "epochSeconds": time.time() - uptime + ticks / hz}


def process_record(pid: int, marker: str) -> dict[str, Any] | None:
    try:
        status = read_text(f"/proc/{pid}/status")
        raw_cmdline = read_bytes(f"/proc/{pid}/cmdline").rstrip(b"\0")
        if not raw_cmdline:
            return None
        if b"\0" in raw_cmdline:
            raw_argv = raw_cmdline.split(b"\0")
            argv = [entry.decode("utf-8", errors="replace")[:MAX_READ_BYTES] for entry in raw_argv]
            command_line = b" ".join(raw_argv)
            argv_encoding = "nul"
        else:
            command_line = raw_cmdline
            argv = command_line.decode("utf-8", errors="replace").split()
            argv_encoding = "space-delimited-proc"
        parent = -1
        for line in status.splitlines():
            if line.startswith("PPid:"):
                parent = int(line.split()[1])
                break
        environ = read_bytes(f"/proc/{pid}/environ")
        display = None
        marker_present = marker.encode("utf-8") + b"=1\0" in environ
        for entry in environ.split(b"\0"):
            if entry.startswith(b"DISPLAY="):
                display = entry.split(b"=", 1)[1].decode("utf-8", errors="replace")[:32]
                break
        try:
            executable = os.readlink(f"/proc/{pid}/exe")
        except OSError:
            executable = None
        try:
            network_namespace = os.readlink(f"/proc/{pid}/ns/net")
        except OSError:
            network_namespace = None
        return {
            "pid": pid,
            "parentPid": parent,
            "argv": argv,
            "argvEncoding": argv_encoding,
            "commandLine": command_line.decode("utf-8", errors="replace")[:MAX_READ_BYTES],
            "executable": executable,
            "networkNamespace": network_namespace,
            "display": display,
            "markerPresent": marker_present,
            "start": process_start_time(pid),
        }
    except (OSError, ValueError):
        return None


def numeric_pids() -> list[int]:
    try:
        return sorted(int(name) for name in os.listdir("/proc") if name.isdigit())
    except OSError:
        return []


def process_snapshot(marker: str) -> list[dict[str, Any]]:
    processes: list[dict[str, Any]] = []
    try:
        pids = numeric_pids()
    except OSError:
        return processes
    for pid in pids:
        record = process_record(pid, marker)
        if record is not None:
            processes.append(record)
    return processes


def all_process_snapshot() -> list[dict[str, Any]]:
    processes: list[dict[str, Any]] = []
    try:
        pids = numeric_pids()
    except OSError:
        return processes
    for pid in pids:
        record = process_record(pid, "__never_present_marker__")
        if record is not None:
            processes.append(record)
    return processes


def process_tree_snapshot(root_pid: int, _marker: str | None = None) -> list[dict[str, Any]]:
    snapshot = all_process_snapshot()
    records = {record["pid"]: record for record in snapshot}
    descendants = {root_pid}
    changed = True
    while changed:
        changed = False
        for record in snapshot:
            if record["parentPid"] in descendants and record["pid"] not in descendants:
                descendants.add(record["pid"])
                changed = True
    selected = [
        record
        for pid, record in records.items()
        if pid != os.getpid() and pid in descendants
    ]
    if len(selected) > MAX_PROCESSES:
        fail(f"process tree exceeded the bounded retained-record count: {len(selected)}")
    return selected


def app_process_snapshot(profile: str, cdp_port: int) -> list[dict[str, Any]]:
    profile_arg = f"--user-data-dir={profile}"
    port_arg = f"--remote-debugging-port={cdp_port}"
    matches = [
        record
        for record in all_process_snapshot()
        if record.get("executable") == "/app/obsidian"
        and profile_arg in record.get("commandLine", "")
        and port_arg in record.get("commandLine", "")
    ]
    if len(matches) > MAX_PROCESSES:
        fail(f"matching app processes exceeded the bounded retained-record count: {len(matches)}")
    return matches


def reference_process_snapshot(profile: str, cdp_port: int) -> list[dict[str, Any]]:
    profile_arg = f"--user-data-dir={profile}"
    port_arg = f"--remote-debugging-port={cdp_port}"
    matches = [
        record
        for record in all_process_snapshot()
        if profile_arg in record.get("commandLine", "")
        and port_arg in record.get("commandLine", "")
    ]
    if len(matches) > MAX_PROCESSES:
        fail(
            f"matching reference processes exceeded the bounded retained-record count: {len(matches)}"
        )
    return matches


def process_lineage(records: list[dict[str, Any]], pid: int) -> list[int]:
    by_pid = {int(record["pid"]): record for record in records}
    lineage: list[int] = []
    current = pid
    seen: set[int] = set()
    while current > 0 and current not in seen:
        seen.add(current)
        lineage.append(current)
        record = by_pid.get(current)
        if record is None:
            break
        current = int(record.get("parentPid", -1))
    return lineage


def write_json(path: str, value: Any) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with open(
        destination,
        "w",
        encoding="utf-8",
        opener=lambda name, flags: os.open(name, flags, 0o600),
    ) as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(destination, 0o600)


def write_bytes(path: str, value: bytes) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with open(destination, "wb", opener=lambda name, flags: os.open(name, flags, 0o600)) as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(destination, 0o600)


def route_snapshot() -> dict[str, Any]:
    route_lines = read_text("/proc/net/route").splitlines()
    routes = [line for line in route_lines[1:] if line.strip()]
    device_lines = read_text("/proc/net/dev").splitlines()[2:]
    devices = [line.split(":", 1)[0].strip() for line in device_lines if ":" in line]
    return {
        "namespace": os.readlink("/proc/self/ns/net"),
        "routes": routes,
        "devices": sorted(devices),
        "noEgressEvidence": not routes and devices == ["lo"],
    }


def tcp_listener_snapshot(port: int) -> list[str]:
    token = f":{port:04X}"
    return [line.strip()[:256] for line in read_text("/proc/net/tcp", 64 * 1024).splitlines() if token in line]


def png_dimensions(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        fail("CDP screenshot is not a PNG with an IHDR chunk")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


class CdpSocket:
    def __init__(self, websocket_url: str) -> None:
        parsed = urllib.parse.urlparse(websocket_url)
        if parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or not parsed.port:
            fail(f"CDP target websocket is not a loopback endpoint: {websocket_url}")
        self.sock = socket.create_connection((parsed.hostname, parsed.port), timeout=2)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {parsed.path or '/'}{('?' + parsed.query) if parsed.query else ''} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{parsed.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Origin: http://127.0.0.1:{parsed.port}\r\n\r\n"
        ).encode("ascii")
        self.sock.sendall(request)
        response = self._read_until(b"\r\n\r\n", 16 * 1024)
        if not response.startswith(b"HTTP/1.1 101"):
            fail(f"CDP WebSocket handshake failed: {response[:200]!r}")
        self.sequence = 0

    def _read_until(self, marker: bytes, limit: int) -> bytes:
        data = b""
        while marker not in data and len(data) < limit:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            data += chunk
        return data

    def _send_frame(self, payload: bytes, opcode: int = 1) -> None:
        if len(payload) > MAX_CDP_FRAME_BYTES:
            fail(f"CDP payload exceeds bounded frame size: {len(payload)}")
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            header = bytes([0x80 | opcode, 0x80 | length])
        elif length < 65536:
            header = bytes([0x80 | opcode, 0x80 | 126]) + length.to_bytes(2, "big")
        else:
            header = bytes([0x80 | opcode, 0x80 | 127]) + length.to_bytes(8, "big")
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _recv_frame(self) -> tuple[int, bytes]:
        header = self.sock.recv(2)
        if len(header) != 2:
            fail("CDP WebSocket closed while reading frame header")
        first, second = header
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = int.from_bytes(self.sock.recv(2), "big")
        elif length == 127:
            length = int.from_bytes(self.sock.recv(8), "big")
        if length > MAX_CDP_FRAME_BYTES:
            fail(f"CDP frame exceeds bounded size: {length}")
        masked = second & 0x80
        mask = self.sock.recv(4) if masked else b""
        data = b""
        while len(data) < length:
            chunk = self.sock.recv(min(65536, length - len(data)))
            if not chunk:
                fail("CDP WebSocket closed while reading frame payload")
            data += chunk
        if masked:
            data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
        return opcode, data

    def send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.sequence += 1
        request_id = self.sequence
        payload = json.dumps({"id": request_id, "method": method, "params": params or {}}).encode("utf-8")
        self._send_frame(payload)
        while True:
            opcode, data = self._recv_frame()
            if opcode == 0x9:
                self._send_frame(data, 0xA)
                continue
            if opcode == 0x8:
                fail("CDP WebSocket closed")
            if opcode != 0x1:
                continue
            message = json.loads(data.decode("utf-8"))
            if message.get("id") != request_id:
                continue
            if "error" in message:
                fail(f"CDP {method} failed: {message['error']}")
            return message.get("result", {})

    def close(self) -> None:
        try:
            self._send_frame(b"\x03\xe8", 0x8)
        except OSError:
            pass
        self.sock.close()


def cdp_target(port: int) -> dict[str, Any]:
    client = socket.create_connection(("127.0.0.1", port), timeout=2)
    client.settimeout(1)
    try:
        client.sendall(
            (
                f"GET /json/list HTTP/1.1\r\n"
                f"Host: localhost:{port}\r\n"
                "User-Agent: threadleaf-obsidian-lab/1\r\n"
                f"Origin: http://127.0.0.1:{port}\r\n"
                "Accept: application/json\r\n\r\n"
            ).encode("ascii")
        )
        response = b""
        while len(response) <= MAX_CDP_HTTP_BYTES:
            try:
                chunk = client.recv(4096)
            except TimeoutError:
                break
            if not chunk:
                break
            response += chunk
            if b"\r\n\r\n" in response:
                _, _, candidate_body = response.partition(b"\r\n\r\n")
                try:
                    json.loads(candidate_body.decode("utf-8"))
                    break
                except (UnicodeDecodeError, json.JSONDecodeError):
                    pass
        _, _, body = response.partition(b"\r\n\r\n")
        if not body:
            fail(f"CDP target list returned no body: {response[:256]!r}")
    finally:
        client.close()
    if len(body) > MAX_CDP_HTTP_BYTES:
        fail("CDP target list exceeded the bounded HTTP payload")
    targets = json.loads(body.decode("utf-8"))
    if not isinstance(targets, list) or len(targets) > 16:
        fail("CDP target list exceeded the bounded target count")
    for target in targets:
        if target.get("type") == "page" and isinstance(target.get("webSocketDebuggerUrl"), str):
            websocket_url = urllib.parse.urlparse(target["webSocketDebuggerUrl"])
            if (
                websocket_url.scheme != "ws"
                or websocket_url.hostname not in {"127.0.0.1", "localhost"}
                or websocket_url.port != port
            ):
                fail(f"CDP target websocket is not the private loopback target: {target['webSocketDebuggerUrl']}")
            return {
                "id": str(target.get("id", ""))[:128],
                "type": "page",
                "title": str(target.get("title", ""))[:256],
                "url": str(target.get("url", ""))[:256],
                "webSocketDebuggerUrl": (
                    f"ws://127.0.0.1:{port}{websocket_url.path or '/'}"
                    f"{('?' + websocket_url.query) if websocket_url.query else ''}"
                )[:256],
            }
    fail("CDP list had no bounded page target")


def runtime_eval(cdp: CdpSocket, expression: str) -> Any:
    if len(expression.encode("utf-8")) > MAX_CDP_EXPRESSION_BYTES:
        fail("CDP expression exceeded the bounded payload size")
    result = cdp.send(
        "Runtime.evaluate",
        {"expression": expression, "awaitPromise": True, "returnByValue": True},
    )
    if result.get("exceptionDetails"):
        fail(f"CDP Runtime.evaluate failed: {result['exceptionDetails']}")
    return result.get("result", {}).get("value")


VISIBLE_EXPRESSION = f"""(() => {{
  const root = document.documentElement;
  const body = document.body;
  const bodyRect = body?.getBoundingClientRect();
  const text = (body?.innerText ?? '').slice(0, {MAX_VISIBLE_TEXT});
  const style = getComputedStyle(root);
  return {{
    readyState: document.readyState,
    title: String(document.title ?? '').slice(0, 256),
    visibleText: text,
    visibleTextLength: text.length,
    viewport: {{ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
      pageScale: visualViewport?.scale ?? 1 }},
    surface: {{ width: bodyRect?.width ?? 0, height: bodyRect?.height ?? 0,
      overflowX: body ? body.scrollWidth - body.clientWidth : 0,
      overflowY: body ? body.scrollHeight - body.clientHeight : 0 }},
    colorScheme: style.colorScheme
  }};
}})()"""


def wait_visible(cdp: CdpSocket, timeout: float = 20.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        first = runtime_eval(cdp, VISIBLE_EXPRESSION)
        time.sleep(0.1)
        second = runtime_eval(cdp, VISIBLE_EXPRESSION)
        last = second
        if (
            isinstance(first, dict)
            and isinstance(second, dict)
            and first.get("readyState") == "complete"
            and second.get("readyState") == "complete"
            and first.get("visibleText") == second.get("visibleText")
            and first.get("title") == second.get("title")
            and first.get("viewport") == second.get("viewport")
            and int(second.get("visibleTextLength", 0)) > 20
        ):
            return second
    fail(f"visible shell did not stabilize: {last!r}")


def normalized_ax(cdp: CdpSocket) -> dict[str, Any]:
    response = cdp.send("Accessibility.getFullAXTree")
    nodes = response.get("nodes", [])
    if not isinstance(nodes, list):
        fail("CDP accessibility result was not a node list")
    if len(nodes) > MAX_AX_NODES * 8:
        fail(f"CDP accessibility result exceeded the bounded node payload: {len(nodes)}")
    normalized = []
    for node in nodes[:MAX_AX_NODES]:
        if not isinstance(node, dict):
            continue

        def value(name: str) -> Any:
            field = node.get(name)
            return field.get("value") if isinstance(field, dict) else None

        normalized.append(
            {
                "role": str(value("role"))[:256] if value("role") is not None else None,
                "name": str(value("name"))[:256] if value("name") is not None else None,
                "description": str(value("description"))[:256] if value("description") is not None else None,
                "value": str(value("value"))[:256] if value("value") is not None else None,
                "level": value("level"),
                "orientation": value("orientation"),
                "checked": value("checked"),
                "selected": value("selected"),
                "expanded": value("expanded"),
                "disabled": value("disabled"),
                "modal": value("modal"),
                "childCount": len(node.get("childIds", [])) if isinstance(node.get("childIds"), list) else 0,
            }
        )
    return {"schemaVersion": 1, "nodeCount": len(nodes), "truncated": len(nodes) > MAX_AX_NODES, "nodes": normalized}


def capture_surface(cdp: CdpSocket, path: str) -> dict[str, Any]:
    result = cdp.send(
        "Page.captureScreenshot",
        {"format": "png", "fromSurface": True, "captureBeyondViewport": False},
    )
    data = result.get("data")
    if not isinstance(data, str):
        fail("CDP returned no surface screenshot")
    image = base64.b64decode(data, validate=True)
    if len(image) <= 1024:
        fail("CDP surface screenshot is unexpectedly small")
    width, height = png_dimensions(image)
    write_bytes(path, image)
    return {
        "path": path,
        "bytes": len(image),
        "sha256": sha256_bytes(image),
        "pngWidth": width,
        "pngHeight": height,
        "fromSurface": True,
        "captureBeyondViewport": False,
        "complete": True,
    }


def wait_process_exit(process: subprocess.Popen[bytes], timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while process.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)
    return process.poll() is not None


def close_cdp(cdp: CdpSocket | None) -> None:
    if cdp is None:
        return
    try:
        cdp.send("Browser.close")
    except Exception:  # noqa: BLE001 - cleanup is bounded and best effort
        try:
            runtime_eval(cdp, "window.close(); true")
        except Exception:
            pass
    cdp.close()


def cdp_key(cdp: CdpSocket, key: str, code: str, key_code: int, modifiers: int = 0) -> None:
    common = {
        "key": key,
        "code": code,
        "windowsVirtualKeyCode": key_code,
        "nativeVirtualKeyCode": key_code,
        "modifiers": modifiers,
    }
    cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", **common})
    cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", **common})


def fixture_predicate(cdp: CdpSocket, require_edit: bool = False) -> dict[str, Any]:
    state = wait_visible(cdp)
    visible_text = str(state.get("visibleText", ""))
    if FIXTURE_PREDICATE not in visible_text or "Overview" not in visible_text:
        fail(
            "fixture-specific visible predicate did not prove the synthetic vault was open: "
            f"visible={visible_text[:MAX_VISIBLE_TEXT]!r}"
        )
    if require_edit and SYNTHETIC_EDIT not in visible_text:
        fail(
            "fixture-specific visible predicate did not prove the synthetic edit: "
            f"visible={visible_text[:MAX_VISIBLE_TEXT]!r}"
        )
    return state


def dismiss_restricted_mode_prompt(cdp: CdpSocket) -> dict[str, Any]:
    wait_visible(cdp)
    button = runtime_eval(
        cdp,
        f"""(() => {{
          const label = {json.dumps(RESTRICTED_MODE_LABEL)};
          const roots = [];
          const seenRoots = new Set();
          const collectRoot = (root) => {{
            if (!root || seenRoots.has(root)) return;
            seenRoots.add(root);
            roots.push(root);
            for (const candidate of root.querySelectorAll?.('*') ?? []) {{
              if (candidate.shadowRoot) collectRoot(candidate.shadowRoot);
            }}
          }};
          collectRoot(document);
          const elements = roots.flatMap((root) => [...root.querySelectorAll('*')]);
          const normalize = (value) => String(value ?? '').replace(/\\s+/gu, ' ').trim();
          const match = elements.slice().reverse().find((candidate) => {{
            const rect = candidate.getBoundingClientRect();
            const style = getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              normalize(candidate.innerText ?? candidate.textContent) === label;
          }});
          if (!match) {{
            const candidates = elements
              .map((candidate) => {{
                const text = normalize(candidate.innerText ?? candidate.textContent);
                const rect = candidate.getBoundingClientRect();
                return {{ candidate, text, rect }};
              }})
              .filter((entry) => entry.text.includes(label) && entry.text.length <= 200)
              .slice(-8)
              .map((entry) => ({{
                tag: entry.candidate.tagName,
                id: entry.candidate.id,
                className: String(entry.candidate.className ?? '').slice(0, 160),
                role: entry.candidate.getAttribute('role'),
                ariaLabel: entry.candidate.getAttribute('aria-label'),
                text: entry.text,
                x: entry.rect.left,
                y: entry.rect.top,
                width: entry.rect.width,
                height: entry.rect.height,
              }}));
            return {{
              found: false,
              candidates,
              rootCount: roots.length,
              elementCount: elements.length,
              bodyText: normalize(document.body?.innerText).slice(0, 2400),
            }};
          }}
          const node = match.closest('button, [role="button"], a') ?? match;
          const rect = node.getBoundingClientRect();
          return {{
            found: true,
            label,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          }};
        }})()""",
    )
    if not isinstance(button, dict) or button.get("found") is not True:
        return {"status": "absent", "label": RESTRICTED_MODE_LABEL, "probe": button}
    x = float(button.get("x", 0))
    y = float(button.get("y", 0))
    if not (0 < x < 800 and 0 < y < 650):
        fail(f"restricted-mode button was outside the measured viewport: {button!r}")
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    cdp.send(
        "Input.dispatchMouseEvent",
        {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1},
    )
    cdp.send(
        "Input.dispatchMouseEvent",
        {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1},
    )
    deadline = time.monotonic() + 10.0
    visible_expression = f"""(() => {{
      const label = {json.dumps(RESTRICTED_MODE_LABEL)};
      const roots = [];
      const seenRoots = new Set();
      const collectRoot = (root) => {{
        if (!root || seenRoots.has(root)) return;
        seenRoots.add(root);
        roots.push(root);
        for (const candidate of root.querySelectorAll?.('*') ?? []) {{
          if (candidate.shadowRoot) collectRoot(candidate.shadowRoot);
        }}
      }};
      collectRoot(document);
      const normalize = (value) => String(value ?? '').replace(/\\s+/gu, ' ').trim();
      return roots.some((root) => [...root.querySelectorAll('*')].some((candidate) => {{
        const rect = candidate.getBoundingClientRect();
        const style = getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          normalize(candidate.innerText ?? candidate.textContent) === label;
      }}));
    }})()"""
    while time.monotonic() < deadline:
        if runtime_eval(cdp, visible_expression) is not True:
            return {"status": "observed", "label": RESTRICTED_MODE_LABEL, "input": "CDP pointer"}
        time.sleep(0.1)
    fail("restricted-mode prompt did not close after the bounded CDP pointer click")


def focus_fixture_editor(cdp: CdpSocket) -> None:
    result = runtime_eval(
        cdp,
        """(() => {
          const nodes = [
            ...document.querySelectorAll(
              '.markdown-source-view.mod-cm6 .cm-content[contenteditable="true"]',
            ),
          ];
          const node = nodes.find((candidate) => candidate.offsetParent !== null);
          if (!node) return { found: false, count: nodes.length, selector: 'CodeMirror 6' };
          node.focus();
          return {
            found: true,
            focused: document.activeElement === node,
            count: nodes.length,
            selector: 'CodeMirror 6',
          };
        })()""",
    )
    if (
        not isinstance(result, dict)
        or result.get("found") is not True
        or result.get("focused") is not True
        or result.get("selector") != "CodeMirror 6"
    ):
        fail(f"fixture editor was not reachable through the bounded UI predicate: {result!r}")


def wait_for_exact_bytes(path: str, expected: bytes, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with open(path, "rb") as handle:
                actual = handle.read(MAX_TREE_FILE_BYTES + 1)
            if actual == expected:
                return
        except OSError:
            pass
        time.sleep(0.1)
    fail(f"synthetic edit was not persisted as the expected exact bytes: {path}")


def file_digest(path: str) -> tuple[int, str]:
    digest = hashlib.sha256()
    counted = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            counted += len(chunk)
            digest.update(chunk)
    return counted, digest.hexdigest()


def terminate_process(process: subprocess.Popen[bytes] | None) -> dict[str, Any]:
    if process is None:
        return {"attempted": False, "clean": True}
    if process.poll() is not None:
        return {"attempted": False, "clean": True, "returncode": process.returncode}
    attempted: list[str] = []
    for action, callback, timeout in (("terminate", process.terminate, 4.0), ("kill", process.kill, 1.0)):
        if process.poll() is not None:
            break
        attempted.append(action)
        try:
            callback()
        except OSError:
            pass
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            continue
    return {"attempted": attempted, "clean": process.poll() is not None, "returncode": process.returncode}


def terminate_process_tree(process: subprocess.Popen[bytes] | None) -> dict[str, Any]:
    if process is None:
        return {"attempted": False, "clean": True}
    root_pid = process.pid
    attempted: list[dict[str, Any]] = []
    for signal_name, signal_number, timeout in (("SIGTERM", 15, 4.0), ("SIGKILL", 9, 1.0)):
        records = all_process_snapshot()
        by_pid = {int(record["pid"]): record for record in records}
        descendants = {
            pid
            for pid in by_pid
            if pid != os.getpid() and pid != root_pid and root_pid in process_lineage(records, pid)
        }
        if len(descendants) > MAX_PROCESSES:
            fail(f"cleanup process tree exceeded the bounded candidate count: {len(descendants)}")
        targets = sorted([*descendants, root_pid], reverse=True)
        if process.poll() is None or descendants:
            for pid in targets:
                try:
                    os.kill(pid, signal_number)
                    attempted.append({"pid": pid, "signal": signal_name})
                except OSError:
                    pass
        if wait_process_exit(process, timeout):
            lingering = [
                record
                for record in all_process_snapshot()
                if int(record["pid"]) in descendants or int(record["pid"]) == root_pid
            ]
            if not lingering:
                return {
                    "attempted": attempted,
                    "clean": True,
                    "returncode": process.returncode,
                }
    lingering = [
        record
        for record in all_process_snapshot()
        if int(record["pid"]) == root_pid or root_pid in process_lineage(all_process_snapshot(), int(record["pid"]))
    ]
    return {
        "attempted": attempted,
        "clean": not lingering,
        "returncode": process.returncode,
        "lingering": lingering,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    root = os.path.realpath(args.run_root)
    profile = os.path.realpath(args.profile)
    vault = os.path.realpath(args.vault)
    for label, value in (("run root", root), ("profile", profile), ("vault", vault)):
        if os.path.commonpath([root, value]) != root:
            fail(f"{label} escaped the run root: {value}")
    network = route_snapshot()
    if network["namespace"] == args.host_network_namespace:
        fail(f"sandbox network namespace was not distinct: {network['namespace']}")
    if not network["noEgressEvidence"]:
        fail(f"sandbox network still has a route or non-loopback device: {network}")

    if not (os.environ.get("DISPLAY") or "").startswith(":"):
        fail(f"isolated supervisor did not receive an Xvfb DISPLAY: {os.environ.get('DISPLAY')!r}")
    if os.environ.get("WAYLAND_DISPLAY"):
        fail("isolated X11 supervisor inherited WAYLAND_DISPLAY")
    fixture_uri = "obsidian://open?path=" + urllib.parse.quote(
        os.path.join(vault, FIXTURE_NOTE), safe=""
    )
    command = [
        "/usr/bin/env",
        f"{args.marker}=1",
        "obsidian.sh",
        "--ozone-platform=x11",
        "--disable-gpu",
        "--no-first-run",
        "--window-size=800,650",
        f"--remote-debugging-port={args.cdp_port}",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-allow-origins=http://127.0.0.1:{args.cdp_port}",
        f"--user-data-dir={profile}",
        vault,
        fixture_uri,
    ]
    environment = os.environ.copy()
    environment[args.marker] = "1"
    environment["ELECTRON_OZONE_PLATFORM_HINT"] = "x11"
    environment["XDG_CONFIG_HOME"] = os.path.join(root, "xdg-config")
    environment["XDG_CACHE_HOME"] = os.path.join(root, "xdg-cache")
    environment["XDG_DATA_HOME"] = os.path.join(root, "xdg-data")
    profile_before = tree_snapshot(profile)
    vault_before = tree_snapshot(vault)
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "status": "blocked",
        "reference": {
            "flatpakId": "md.obsidian.Obsidian",
            "version": args.reference_version,
            "runtime": args.reference_runtime,
            "commit": args.reference_commit,
            "executable": None,
        },
        "display": {
            "value": os.environ.get("DISPLAY"),
            "wayland": os.environ.get("WAYLAND_DISPLAY"),
            "x11Required": True,
            "screen": "1440x840x24",
        },
        "network": {**network, "hostNamespace": args.host_network_namespace},
        "paths": {"runRoot": root, "profile": profile_before, "vault": vault_before},
        "command": command,
        "uriDispatch": None,
        "appPid": None,
        "supervisorPid": os.getpid(),
        "startedEpochSeconds": time.time(),
        "target": None,
        "reopenTarget": None,
        "cdp": None,
        "visible": None,
        "visibleBeforeEdit": None,
        "ax": None,
        "screenshot": None,
        "roundtrip": None,
        "processes": [],
        "rendererProcesses": [],
        "reopenProcesses": [],
        "lineage": None,
        "reopenLineage": None,
        "cleanup": None,
        "appProcessesAfterCleanup": [],
        "referenceProcessesAfterCleanup": [],
    }
    process: subprocess.Popen[bytes] | None = None
    reopen_process: subprocess.Popen[bytes] | None = None
    cdp: CdpSocket | None = None
    reopen_cdp: CdpSocket | None = None
    cdps: list[CdpSocket] = []

    def start_app() -> subprocess.Popen[bytes]:
        return subprocess.Popen(command, env=environment)

    def connect_app(app_process: subprocess.Popen[bytes]) -> tuple[dict[str, Any], CdpSocket]:
        deadline = time.monotonic() + 20.0
        last_error: str | None = None
        target: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            if app_process.poll() is not None:
                fail(f"Obsidian launcher exited before CDP: {app_process.returncode}")
            try:
                target = cdp_target(args.cdp_port)
                break
            except Exception as error:  # noqa: BLE001 - bounded launch retry
                last_error = f"{error}; tcp={tcp_listener_snapshot(args.cdp_port)}"
                time.sleep(0.1)
        if target is None:
            fail(f"CDP target unavailable: {last_error}")
        socket_ = CdpSocket(target["webSocketDebuggerUrl"])
        cdps.append(socket_)
        socket_.send("Runtime.enable")
        socket_.send("Page.enable")
        socket_.send("Accessibility.enable")
        return target, socket_

    try:
        process = start_app()
        target, cdp = connect_app(process)
        result["target"] = dict(target)
        result["target"]["port"] = args.cdp_port
        result["target"]["address"] = "127.0.0.1"
        browser_version = cdp.send("Browser.getVersion")
        user_agent = str(browser_version.get("userAgent", ""))[:256]
        if "obsidian/1.13.7" not in user_agent.lower():
            fail(f"Browser user agent did not identify Obsidian 1.13.7: {user_agent!r}")
        result["cdp"] = {
            "browserVersion": {
                key: str(browser_version.get(key, ""))[:256]
                for key in ("product", "revision", "userAgent", "jsVersion")
            }
        }
        result["processes"] = process_tree_snapshot(process.pid, args.marker)
        result["rendererProcesses"] = [
            record for record in result["processes"] if "--type=renderer" in record["commandLine"]
        ]
        if not result["rendererProcesses"]:
            fail("no renderer process was observable inside the isolated namespace")
        if any(
            "--ozone-platform=x11" not in record["commandLine"]
            for record in result["rendererProcesses"]
        ):
            fail(f"renderer omitted explicit X11 argv: {result['rendererProcesses']}")
        if any("--ozone-platform=wayland" in record["commandLine"] for record in result["rendererProcesses"]):
            fail(f"renderer selected Wayland: {result['rendererProcesses']}")
        if any(record["networkNamespace"] != network["namespace"] for record in result["rendererProcesses"]):
            fail("renderer network namespace did not match the isolated supervisor namespace")
        result["supervisorProcess"] = process_record(os.getpid(), args.marker)
        result["appProcess"] = next(
            (record for record in result["processes"] if record["pid"] == process.pid), None
        )
        if not result["appProcess"]:
            fail("the launched app process was not present in the in-sandbox process receipt")
        result["appPid"] = result["appProcess"]["pid"]
        result["reference"]["executable"] = result["appProcess"].get("executable")
        if result["appProcess"].get("parentPid") != result["supervisorPid"]:
            fail("the captured app was not a direct child of the in-sandbox supervisor")
        if result["appProcess"].get("networkNamespace") != network["namespace"]:
            fail("the captured app escaped the isolated network namespace")
        app_argv = result["appProcess"].get("argv", [])
        expected_app_args = {
            "--ozone-platform=x11",
            "--disable-gpu",
            "--no-first-run",
            "--window-size=800,650",
            f"--remote-debugging-port={args.cdp_port}",
            "--remote-debugging-address=127.0.0.1",
            f"--remote-allow-origins=http://127.0.0.1:{args.cdp_port}",
            f"--user-data-dir={profile}",
        }
        if (
            not app_argv
            or app_argv[0] != "/app/obsidian"
            or not expected_app_args.issubset(set(app_argv))
            or vault not in app_argv
            or fixture_uri not in app_argv
        ):
            fail(f"app argv did not retain the exact isolated launch: {app_argv!r}")
        result["lineage"] = {
            "supervisorPid": result["supervisorPid"],
            "appPid": result["appProcess"]["pid"],
            "app": process_lineage(result["processes"], result["appProcess"]["pid"]),
            "renderers": {
                str(record["pid"]): process_lineage(result["processes"], record["pid"])
                for record in result["rendererProcesses"]
            },
        }
        result["uriDispatch"] = {
            "argv": app_argv,
            "parentPid": os.getpid(),
            "accepted": True,
            "source": "in-sandbox initial app argv",
            "private": True,
        }
        result["restrictedMode"] = dismiss_restricted_mode_prompt(cdp)
        result["visibleBeforeEdit"] = fixture_predicate(cdp)
        note_path = os.path.join(vault, FIXTURE_NOTE)
        with open(note_path, "rb") as handle:
            before_bytes = handle.read(MAX_TREE_FILE_BYTES + 1)
        if len(before_bytes) > MAX_TREE_FILE_BYTES:
            fail("fixture note exceeded the bounded edit input")
        focus_fixture_editor(cdp)
        cdp_key(cdp, "End", "End", 35, modifiers=2)
        edit_bytes = f"{SYNTHETIC_EDIT}\n".encode("utf-8")
        cdp.send("Input.insertText", {"text": edit_bytes.decode("utf-8")})
        fixture_predicate(cdp, require_edit=True)
        cdp_key(cdp, "s", "KeyS", 83, modifiers=2)
        expected_bytes = before_bytes + edit_bytes
        wait_for_exact_bytes(note_path, expected_bytes)
        before_size, before_sha = len(before_bytes), sha256_bytes(before_bytes)
        mutated_size, mutated_sha = file_digest(note_path)
        if mutated_size != len(expected_bytes) or mutated_sha != sha256_bytes(expected_bytes):
            fail("saved fixture note hash did not match the exact synthetic edit")
        result["roundtrip"] = {
            "status": "editing",
            "fixtureNote": FIXTURE_NOTE,
            "edit": SYNTHETIC_EDIT,
            "beforeBytes": before_size,
            "beforeSha256": before_sha,
            "mutatedBytes": mutated_size,
            "mutatedSha256": mutated_sha,
            "expectedMutatedSha256": sha256_bytes(expected_bytes),
            "exactSave": True,
        }
        close_cdp(cdp)
        cdps.remove(cdp)
        cdp = None
        first_cleanup = terminate_process_tree(process)
        if not first_cleanup["clean"]:
            fail(f"first app process did not exit cleanly: {first_cleanup}")
        reopen_process = start_app()
        reopen_target, reopen_cdp = connect_app(reopen_process)
        result["reopenTarget"] = dict(reopen_target)
        result["reopenTarget"]["port"] = args.cdp_port
        result["reopenTarget"]["address"] = "127.0.0.1"
        if (
            result["reopenTarget"].get("port") != result["target"].get("port")
            or not str(result["reopenTarget"].get("webSocketDebuggerUrl", "")).startswith(
                f"ws://127.0.0.1:{args.cdp_port}/"
            )
        ):
            fail("reopen CDP target did not remain on the same private loopback port")
        result["reopenRestrictedMode"] = dismiss_restricted_mode_prompt(reopen_cdp)
        reopened_state = fixture_predicate(reopen_cdp, require_edit=True)
        result["visible"] = reopened_state
        with open(note_path, "rb") as handle:
            reopened_bytes = handle.read(MAX_TREE_FILE_BYTES + 1)
        reopened_size, reopened_sha = file_digest(note_path)
        result["roundtrip"].update(
            {
                "status": "observed",
                "reopenedBytes": reopened_size,
                "reopenedSha256": reopened_sha,
                "exact": reopened_bytes == expected_bytes and reopened_sha == mutated_sha,
            }
        )
        if not result["roundtrip"]["exact"]:
            fail("reopened fixture note did not retain the exact saved bytes")
        result["ax"] = normalized_ax(reopen_cdp)
        result["screenshot"] = capture_surface(reopen_cdp, args.screenshot)
        result["reopenProcesses"] = process_tree_snapshot(reopen_process.pid, args.marker)
        reopen_app = next(
            (record for record in result["reopenProcesses"] if record["pid"] == reopen_process.pid),
            None,
        )
        if not reopen_app:
            fail("the reopened app process was not present in the in-sandbox process receipt")
        if (
            reopen_app.get("executable") != "/app/obsidian"
            or reopen_app.get("parentPid") != result["supervisorPid"]
            or reopen_app.get("networkNamespace") != network["namespace"]
            or reopen_app.get("argv") != result["appProcess"].get("argv")
        ):
            fail("reopen app argv/lineage did not match the randomized first launch")
        result["reopenLineage"] = {
            "appPid": reopen_process.pid,
            "app": process_lineage(result["reopenProcesses"], reopen_process.pid),
            "renderers": {
                str(record["pid"]): process_lineage(result["reopenProcesses"], record["pid"])
                for record in result["reopenProcesses"]
                if "--type=renderer" in record.get("commandLine", "")
            },
        }
        result["status"] = "observed"
        close_cdp(reopen_cdp)
        cdps.remove(reopen_cdp)
        reopen_cdp = None
    except Exception as error:  # noqa: BLE001 - preserve bounded failure evidence
        result["status"] = "blocked"
        result["reason"] = str(error)
    finally:
        for socket_ in list(cdps):
            try:
                close_cdp(socket_)
            except Exception:
                socket_.close()
            cdps.remove(socket_)
        cleanup_results = []
        if process is not None:
            cleanup_results.append({"phase": "initial", **terminate_process_tree(process)})
        if reopen_process is not None:
            cleanup_results.append({"phase": "reopen", **terminate_process_tree(reopen_process)})
        result["cleanup"] = {
            "phases": cleanup_results,
            "clean": all(item.get("clean") for item in cleanup_results),
        }
        result["processesAfterCleanup"] = process_tree_snapshot(
            process.pid if process is not None else -1, args.marker
        )
        result["appProcessesAfterCleanup"] = app_process_snapshot(profile, args.cdp_port)
        result["referenceProcessesAfterCleanup"] = reference_process_snapshot(profile, args.cdp_port)
        if (
            result["processesAfterCleanup"]
            or result["appProcessesAfterCleanup"]
            or result["referenceProcessesAfterCleanup"]
        ):
            result["status"] = "blocked"
            result["cleanup"]["clean"] = False
        result["finishedEpochSeconds"] = time.time()
        result["pathsAfterCleanup"] = {"profile": tree_snapshot(profile), "vault": tree_snapshot(vault)}
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--cdp-port", required=True, type=int)
    parser.add_argument("--marker", required=True)
    parser.add_argument("--host-network-namespace", required=True)
    parser.add_argument("--reference-version", required=True)
    parser.add_argument("--reference-runtime", required=True)
    parser.add_argument("--reference-commit", required=True)
    parser.add_argument("--screenshot", required=True)
    parser.add_argument("--result", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result = run(args)
    except Exception as error:  # noqa: BLE001 - receipt must explain every block
        result = {"schemaVersion": 1, "status": "blocked", "reason": str(error), "cleanup": {"clean": False}}
    write_json(args.result, result)
    return 0 if result.get("status") == "observed" and result.get("cleanup", {}).get("clean") else 1


if __name__ == "__main__":
    sys.exit(main())

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
import urllib.request
from pathlib import Path
from typing import Any


MAX_READ_BYTES = 64 * 1024
MAX_TREE_FILE_BYTES = 64 * 1024 * 1024
MAX_PROCESSES = 512
MAX_AX_NODES = 256
MAX_VISIBLE_TEXT = 2400


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
        command_line = read_bytes(f"/proc/{pid}/cmdline").rstrip(b"\0").replace(b"\0", b" ")
        if not command_line:
            return None
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
            "commandLine": command_line.decode("utf-8", errors="replace")[:MAX_READ_BYTES],
            "executable": executable,
            "networkNamespace": network_namespace,
            "display": display,
            "markerPresent": marker_present,
            "start": process_start_time(pid),
        }
    except (OSError, ValueError):
        return None


def process_snapshot(marker: str) -> list[dict[str, Any]]:
    processes: list[dict[str, Any]] = []
    try:
        pids = sorted(int(name) for name in os.listdir("/proc") if name.isdigit())
    except OSError:
        return processes
    for pid in pids[:MAX_PROCESSES]:
        record = process_record(pid, marker)
        if record is not None:
            processes.append(record)
    return processes


def process_tree_snapshot(root_pid: int, marker: str) -> list[dict[str, Any]]:
    snapshot = process_snapshot(marker)
    records = {record["pid"]: record for record in snapshot}
    descendants = {root_pid}
    changed = True
    while changed:
        changed = False
        for record in snapshot:
            if record["parentPid"] in descendants and record["pid"] not in descendants:
                descendants.add(record["pid"])
                changed = True
    return [
        record
        for pid, record in records.items()
        if pid != os.getpid() and (pid in descendants or record["markerPresent"])
    ]


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
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
        targets = json.load(response)
    for target in targets:
        if target.get("type") == "page" and isinstance(target.get("webSocketDebuggerUrl"), str):
            return {
                "id": str(target.get("id", ""))[:128],
                "type": "page",
                "title": str(target.get("title", ""))[:256],
                "url": str(target.get("url", ""))[:256],
                "webSocketDebuggerUrl": target["webSocketDebuggerUrl"],
            }
    fail("CDP list had no bounded page target")


def runtime_eval(cdp: CdpSocket, expression: str) -> Any:
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

    command = [
        "/usr/bin/env",
        f"{args.marker}=1",
        "obsidian.sh",
        "--ozone-platform=x11",
        "--disable-gpu",
        "--no-first-run",
        f"--remote-debugging-port={args.cdp_port}",
        "--remote-debugging-address=127.0.0.1",
        f"--remote-allow-origins=http://127.0.0.1:{args.cdp_port}",
        f"--user-data-dir={profile}",
        vault,
    ]
    environment = os.environ.copy()
    environment[args.marker] = "1"
    environment["ELECTRON_OZONE_PLATFORM_HINT"] = "x11"
    environment["XDG_CONFIG_HOME"] = os.path.join(root, "xdg-config")
    environment["XDG_CACHE_HOME"] = os.path.join(root, "xdg-cache")
    environment["XDG_DATA_HOME"] = os.path.join(root, "xdg-data")
    profile_before = tree_snapshot(profile)
    vault_before = tree_snapshot(vault)
    process = subprocess.Popen(command, env=environment)
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
        },
        "network": {**network, "hostNamespace": args.host_network_namespace},
        "paths": {"runRoot": root, "profile": profile_before, "vault": vault_before},
        "command": command,
        "appPid": process.pid,
        "supervisorPid": os.getpid(),
        "startedEpochSeconds": time.time(),
        "target": None,
        "visible": None,
        "ax": None,
        "screenshot": None,
        "processes": [],
        "rendererProcesses": [],
        "cleanup": None,
    }
    cdp: CdpSocket | None = None
    try:
        deadline = time.monotonic() + 20.0
        last_error: str | None = None
        target: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                fail(f"Obsidian launcher exited before CDP: {process.returncode}")
            try:
                target = cdp_target(args.cdp_port)
                break
            except Exception as error:  # noqa: BLE001 - bounded launch retry
                last_error = str(error)
                time.sleep(0.1)
        if target is None:
            fail(f"CDP target unavailable: {last_error}")
        result["target"] = {key: value for key, value in target.items() if key != "webSocketDebuggerUrl"}
        result["target"]["port"] = args.cdp_port
        result["target"]["address"] = "127.0.0.1"
        cdp = CdpSocket(target["webSocketDebuggerUrl"])
        cdp.send("Runtime.enable")
        cdp.send("Page.enable")
        cdp.send("Accessibility.enable")
        result["visible"] = wait_visible(cdp)
        result["ax"] = normalized_ax(cdp)
        result["screenshot"] = capture_surface(cdp, args.screenshot)
        result["processes"] = process_tree_snapshot(process.pid, args.marker)
        result["rendererProcesses"] = [
            record for record in result["processes"] if "--type=renderer" in record["commandLine"]
        ]
        if not result["rendererProcesses"]:
            fail("no renderer process was observable inside the isolated namespace")
        if any("--ozone-platform=x11" not in record["commandLine"] for record in result["rendererProcesses"]):
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
        result["reference"]["executable"] = result["appProcess"].get("executable")
        if result["display"]["wayland"]:
            fail("WAYLAND_DISPLAY was present in the isolated X11 launch")
        result["status"] = "observed"
        try:
            cdp.send("Browser.close")
        except Exception:  # noqa: BLE001 - process cleanup remains authoritative
            try:
                runtime_eval(cdp, "window.close(); true")
            except Exception:
                pass
    finally:
        if cdp is not None:
            cdp.close()
        result["cleanup"] = terminate_process(process)
        result["processesAfterCleanup"] = process_tree_snapshot(process.pid, args.marker)
        if result["processesAfterCleanup"]:
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

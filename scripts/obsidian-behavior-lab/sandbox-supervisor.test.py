#!/usr/bin/env python3
"""Red-control the bounded PID scan against high-PID targets."""

from __future__ import annotations

import importlib.util
from pathlib import Path


module_path = Path(__file__).with_name("sandbox-supervisor.py")
spec = importlib.util.spec_from_file_location("sandbox_supervisor", module_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


decoy_pids = list(range(10, 523))
target_pid = 90_000
all_pids = decoy_pids + [target_pid]
original_listdir = module.os.listdir
original_process_record = module.process_record
try:
    module.os.listdir = lambda path: [str(pid) for pid in all_pids] if path == "/proc" else original_listdir(path)
    module.process_record = lambda pid, marker: {
        "pid": pid,
        "parentPid": 1,
        "argv": ["decoy"],
        "argvEncoding": "nul",
        "commandLine": "decoy",
        "executable": "/decoy",
        "networkNamespace": "net:[fixture]",
        "display": None,
        "markerPresent": False,
        "start": {"epochSeconds": 1},
    }
    records = module.all_process_snapshot()
    assert len(records) == 514, len(records)
    assert records[-1]["pid"] == target_pid, records[-1]
    tree = module.process_tree_snapshot(target_pid)
    assert [record["pid"] for record in tree] == [target_pid], tree
finally:
    module.os.listdir = original_listdir
    module.process_record = original_process_record

print("high-PID discovery red control: observed")

#!/usr/bin/env python3
"""Check that ops undo exactly and that undo survives a restart; optionally
show that each check fails on a broken copy of the code."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
TESTS = {
    "ops": "every_op_undoes_exactly",
    "restart": "undo_survives_a_restart",
}


def command(test):
    return ["cargo", "test", "--locked", "-p", "finite-design", "--test", "ops_exhaustive",
            "--release", TESTS[test], "--", "--exact", "--include-ignored", "--nocapture"]


# (what breaks, file, code today, broken code, test that must catch it)
MUTATIONS = [
    ("move forgets its old parent", "crates/design/src/document.rs",
     "id: id.clone(),\n                    parent: node.parent.clone(),",
     "id: id.clone(),\n                    parent: parent.clone(),", "ops"),
    ("delete restores only its root", "crates/design/src/document.rs",
     ".map(|node| Op::Create { node })", ".take(1).map(|node| Op::Create { node })", "ops"),
    ("inverses run in the wrong order", "crates/design/src/document.rs",
     "inverse.into_iter().rev().flatten()", "inverse.into_iter().flatten()", "ops"),
    ("same value counts as a change", "crates/design/src/document.rs",
     "if previous == value {\n                    return Ok(Unchanged);",
     "if previous == value && false {\n                    return Ok(Unchanged);", "ops"),
    ("removing a node leaves it in the child index", "crates/design/src/document.rs",
     "siblings.remove(&(node.index.clone(), node.id.clone()));", "", "ops"),
    ("replay stops at a stale undo entry", "crates/design/src/design.rs",
     "if applied.is_empty() {\n                continue;\n            }\n            if applied != change.ops",
     "if applied.is_empty() {\n                return false;\n            }\n            if applied != change.ops",
     "restart"),
    ("replay forgets an edit's inverse", "crates/design/src/design.rs",
     ".record(change.label.clone(), inverse);", ".record(change.label.clone(), Vec::new());",
     "restart"),
    ("snapshots leave out histories", "crates/design/src/design.rs",
     "histories: (!self.histories.is_empty()).then(|| self.histories.clone()),",
     "histories: None,", "restart"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutations", action="store_true",
                        help="also break each guarded step in a scratch copy and require a failure")
    args = parser.parse_args()
    for test in TESTS:
        subprocess.run(command(test), cwd=ROOT, check=True)
    if not args.mutations:
        return
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--no-deps"], cwd=ROOT))
    env = dict(os.environ, CARGO_TARGET_DIR=metadata["target_directory"], FINITE_FAIL_FAST="1")
    with tempfile.TemporaryDirectory(prefix="finite-ops-") as directory:
        scratch = Path(directory)
        for filename in ["Cargo.toml", "Cargo.lock"]:
            shutil.copy2(ROOT / filename, scratch / filename)
        shutil.copytree(ROOT / "crates", scratch / "crates")
        for label, filename, before, after, test in MUTATIONS:
            path = scratch / filename
            original = path.read_text()
            if original.count(before) != 1:
                raise RuntimeError(f"mutation drift, update check.py: {label}")
            try:
                path.write_text(original.replace(before, after))
                result = subprocess.run(command(test), cwd=scratch, env=env,
                                        capture_output=True, text=True)
                output = result.stdout + result.stderr
                # A compiler error is not evidence that the check caught anything.
                if result.returncode == 0 or "test result: FAILED" not in output:
                    raise RuntimeError(f"mutation not caught: {label}\n{output}")
                print(f"CAUGHT: {label}", flush=True)
            finally:
                path.write_text(original)


if __name__ == "__main__":
    main()

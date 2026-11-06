#!/usr/bin/env python3
"""Check the finite selector domain; optionally test detection in a scratch copy."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
COMMANDS = [
    ["cargo", "test", "--locked", "-p", "finite-design", "--test", "select_exhaustive", "--release", "--", "--nocapture"],
    ["cargo", "test", "--locked", "-p", "finite-server", "--lib", "exhaustive_selector_adapter", "--", "--nocapture"],
]


def run_checks(root):
    for command in COMMANDS:
        subprocess.run(command, cwd=root, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mutations", action="store_true")
    args = parser.parse_args()
    run_checks(ROOT)
    if not args.mutations:
        return
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--no-deps"], cwd=ROOT))
    env = dict(os.environ, CARGO_TARGET_DIR=metadata["target_directory"])
    mutations = [
        ("scope includes its root", "crates/design/src/select.rs", "(i + 1, matcher.entries[i as usize].end)", "(i, matcher.entries[i as usize].end)", 0),
        ("child has no parent", "crates/design/src/select.rs", "self.at(self.entry().parent)", "None", 0),
        ("siblings disconnected", "crates/design/src/select.rs", "self.at(self.entry().prev)", "None", 0),
        ("node ids ignored", "crates/design/src/select.rs", "case.eq(node.id.as_bytes(), id.0.as_bytes())", "false", 0),
        ("MCP ignores page", "crates/server/src/mcp/selector.rs", "Some(page) => select::Scope::Page(page)", "Some(_page) => select::Scope::Design", 1),
        ("MCP ignores aliases", "crates/server/src/mcp/selector.rs", "out.push_str(id);", "out.push_str(name);", 1),
    ]
    with tempfile.TemporaryDirectory(prefix="finite-selectors-") as directory:
        scratch = Path(directory)
        for filename in ["Cargo.toml", "Cargo.lock"]:
            shutil.copy2(ROOT / filename, scratch / filename)
        shutil.copytree(ROOT / "crates", scratch / "crates")
        for label, filename, before, after, command in mutations:
            path = scratch / filename
            original = path.read_text()
            if original.count(before) != 1:
                raise RuntimeError(f"mutation drift: {label}")
            try:
                path.write_text(original.replace(before, after))
                result = subprocess.run(COMMANDS[command], cwd=scratch, env=env,
                                        capture_output=True, text=True)
                output = result.stdout + result.stderr
                # A compiler error is not evidence of detecting wrong behavior.
                if result.returncode == 0 or "test result: FAILED" not in output:
                    raise RuntimeError(f"mutation not caught: {label}\n{output}")
                print(f"CAUGHT: {label}", flush=True)
            finally:
                path.write_text(original)
    run_checks(ROOT)


if __name__ == "__main__":
    main()

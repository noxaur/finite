"""Drive a headless Finite from Python: a server, headless Chrome and MCP agents.

A Python client for the same session `node e2e/headless.mjs` runs. Each method
sends one command to the session's background process and returns its result
as Python data. It needs Node on the PATH, and nothing outside the standard
library.

    import sys
    sys.path.insert(0, "e2e")
    from finite_headless import Finite, design_id, id_after

    with Finite.start(build=False) as finite:
        design = design_id(finite.call("create_design", name="Test"))
        board = id_after(
            finite.call("create_artboard", designId=design, name="Page", width=800, height=500),
            "artboard",
        )
        finite.call("write_html", designId=design, targetId=board, html="<button>Go</button>")
        finite.design(design)
        finite.click(f'[data-artboard="{board}"] >>> button')
        print(finite.screenshot())

`Finite.start()` stops the session when the `with` block ends.
`Finite.connect()` attaches to a session already running, say one an agent
started from the shell, and leaves it running. Selectors work as in the CLI:
they reach into shadow roots, `>>>` searches inside a match, and `nth` picks
one of several matches. Run `node e2e/headless.mjs help` for the details.
"""

from __future__ import annotations

import json
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "e2e" / "headless.mjs"


class HeadlessError(Exception):
    """A command failed: nothing matched, a wait timed out, or the page threw."""


class ToolError(HeadlessError):
    """An MCP tool reported an error. The message is the tool's text."""


def design_id(text: str) -> str:
    """The designId in create_design's reply."""
    match = re.search(r'designId "([a-z0-9]+)"', text)
    if not match:
        raise ValueError(f"no designId in: {text}")
    return match.group(1)


def id_after(text: str, label: str) -> str:
    """The first `#id` after `label` in a tool's outline, like id_after(text, '"CTA"')."""
    at = text.find(label)
    match = re.search(r"#([a-z0-9]+)", text[at:]) if at >= 0 else None
    if not match:
        raise ValueError(f"no #id after {label} in: {text}")
    return match.group(1)


def _node(*args: str, session: str | None, capture: bool = True) -> subprocess.CompletedProcess:
    command = ["node", str(SCRIPT), *args]
    if session:
        command += ["--session", session]
    return subprocess.run(command, cwd=ROOT, capture_output=capture, text=True)


class Finite:
    """One headless Finite session. Make one with `start()` or `connect()`."""

    def __init__(self, state: dict, session: str | None = None, owned: bool = False):
        self.base: str = state["base"]
        """Where the page loads from, like http://127.0.0.1:52011."""
        self.server: str = state["server"]
        """Where MCP and the API answer. The same as `base` unless attached to `vp run dev`."""
        self.dir = Path(state["dir"])
        """The session's folder: its logs and screenshots."""
        self.session = session
        self._control = f"http://127.0.0.1:{state['port']}/"
        self._token = state["token"]
        self._owned = owned

    @classmethod
    def start(
        cls,
        *,
        build: bool = True,
        session: str | None = None,
        url: str | None = None,
        server: str | None = None,
        width: int | None = None,
        height: int | None = None,
        idle_minutes: float | None = None,
    ) -> Finite:
        """Build (unless build=False), then start a session, as `headless.mjs start` does.

        Pass `url`, and `server` if MCP answers elsewhere, to attach to a
        Finite that's already running, like `vp run dev`. The build's output
        goes to this process's stdout.
        """
        args = ["start"]
        if not build:
            args.append("--no-build")
        for flag, value in [
            ("--url", url),
            ("--server", server),
            ("--width", width),
            ("--height", height),
            ("--idle", idle_minutes),
        ]:
            if value is not None:
                args += [flag, str(value)]
        if _node(*args, session=session, capture=False).returncode != 0:
            raise HeadlessError("the session didn't start: see the output above")
        finite = cls.connect(session)
        finite._owned = True
        return finite

    @classmethod
    def connect(cls, session: str | None = None) -> Finite:
        """Attach to the session already running in this checkout."""
        res = _node("state", session=session)
        if res.returncode != 0:
            raise HeadlessError((res.stderr or res.stdout).strip())
        return cls(json.loads(res.stdout), session)

    def __enter__(self) -> Finite:
        return self

    def __exit__(self, *exc: object) -> None:
        if self._owned:
            self.stop()

    def _send(self, body: dict, timeout: float = 600) -> Any:
        request = urllib.request.Request(
            self._control,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self._token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as res:
                reply = json.load(res)
        except urllib.error.URLError as error:
            raise HeadlessError(f"the session didn't answer ({error.reason})") from None
        if not reply["ok"]:
            raise (ToolError if body["command"] == "call" else HeadlessError)(reply["out"])
        return reply.get("value", reply.get("out"))

    def _command(self, command: str, *args: object, **flags: object) -> Any:
        return self._send(
            {
                "command": command,
                "args": [str(a) for a in args],
                "flags": {
                    k: v if isinstance(v, bool) else str(v) for k, v in flags.items() if v is not None
                },
            }
        )

    # The session.

    def status(self) -> str:
        return self._command("status")

    def stop(self) -> None:
        """Stop the server and Chrome, and delete the data. An attached server keeps running."""
        try:
            self._command("stop")
        except HeadlessError:
            pass

    def logs(self, lines: int = 50) -> str:
        """The server's last log lines."""
        res = _node("logs", "-n", str(lines), session=self.session)
        if res.returncode != 0:
            raise HeadlessError(res.stderr.strip())
        return res.stdout

    # Agents.

    def tools(self) -> list[dict]:
        """Every MCP tool: name, description and inputSchema."""
        return self._command("tools")

    def call(self, tool: str, args: dict | None = None, /, *, agent: str | None = None, **kwargs: Any) -> str:
        """Call an MCP tool and return its text. Raises ToolError if the tool reports one.

        Pass the tool's input as a dict, as keywords, or both. Each `agent`
        name is a separate MCP session with its own undo history; the default
        is "Agent".
        """
        return self.call_full(tool, args, agent=agent, **kwargs)["text"]

    def call_full(
        self, tool: str, args: dict | None = None, /, *, agent: str | None = None, **kwargs: Any
    ) -> dict:
        """Like `call`, but returns {"text": ..., "images": [paths]}, with any images saved as files."""
        return self._send(
            {"command": "call", "tool": tool, "args": {**(args or {}), **kwargs}, "agent": agent}
        )

    def api(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        """Call the web API, like api("GET", "/api/designs"). Returns the status and the decoded body."""
        request = urllib.request.Request(
            f"{self.server}{path}",
            method=method.upper(),
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json"} if body is not None else {},
        )
        try:
            with urllib.request.urlopen(request) as res:
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as error:
            status, raw = error.code, error.read()
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, raw.decode(errors="replace")

    # The page.

    def open(self, path: str | None = None) -> str:
        """Load a page: "/" is the design list. No path reloads the current one."""
        return self._command("open", *([path] if path else []))

    def design(self, design_id: str) -> dict:
        """Open a design and wait for its artboards: {"name", "artboards", "rendered"}."""
        return self._command("design", design_id)

    def screenshot(self, path: str | Path | None = None, *, selector: str | None = None, nth: int | None = None) -> Path:
        """Save a PNG of the page, or of one element, and return its path."""
        args = [str(Path(path).resolve())] if path else []
        return Path(self._command("screenshot", *args, selector=selector, nth=nth))

    def snapshot(self, selector: str | None = None, *, nth: int | None = None) -> str:
        """The accessibility tree, one node per line, like `button "Start"`."""
        return self._command("snapshot", selector=selector, nth=nth)

    def text(self, selector: str | None = None, *, nth: int | None = None) -> str:
        """The visible text of the page, or of one element, artboards included."""
        return self._command("text", selector=selector, nth=nth)

    def query(self, selector: str) -> list[dict]:
        """Every match: tag, id, cls, label, text, x, y, w, h, inView, and shadow (inside an artboard)."""
        return self._command("query", selector)

    def eval(self, expression: str) -> Any:
        """Evaluate JavaScript in the page and return its value. $deep and $$deep are defined."""
        return self._command("eval", expression)

    def wait(self, expression: str, timeout: float = 5) -> Any:
        """Wait up to `timeout` seconds for the expression to be truthy, and return its value."""
        return self._command("wait", expression, timeout=round(timeout * 1000))

    def click(self, target: str | float, y: float | None = None, *, nth: int | None = None) -> str:
        """Click an element's center, by selector, or a point: click(470, 300)."""
        return self._command("click", *self._target(target, y), nth=nth)

    def hover(self, target: str | float, y: float | None = None, *, nth: int | None = None) -> str:
        """Move the mouse to an element's center, by selector, or to a point."""
        return self._command("hover", *self._target(target, y), nth=nth)

    def type(self, text: str) -> str:
        """Type into the focused element."""
        return self._command("type", text)

    def key(self, spec: str) -> str:
        """Press a key: "Enter", "Escape", "c", "Shift+1", "Meta+z"."""
        return self._command("key", spec)

    def viewport(self, width: int, height: int) -> str:
        return self._command("viewport", width, height)

    def console(self, all: bool = False) -> list[dict]:
        """What the page logged since the last call (or ever, with all=True): at, level, text."""
        return self._command("console", all=all)

    @staticmethod
    def _target(target: str | float, y: float | None) -> list:
        return [target] if y is None else [target, y]

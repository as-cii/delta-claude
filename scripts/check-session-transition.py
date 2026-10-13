#!/usr/bin/env python3
"""Probe installed Claude's idle clear/cd transition without making model requests."""

import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import tempfile
import time


HOOKS = r"""
export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({name: 'transition-probe', description: 'Probe clear/cd'})
    return next(e)
  })
  on('command.run', {command: 'transition-probe'}, async ($) => {
    const root = await $.env.get('TRANSITION_ROOT')
    const before = {id: await $.session.id(), cwd: await $.session.cwd()}
    $.clock.after(0, async () => {
      try {
        const clear = await $.command.run({command: 'clear'})
        const fresh = {id: await $.session.id(), cwd: await $.session.cwd()}
        const cd = await $.command.run({command: 'cd', args: root + '/target'})
        const after = {id: await $.session.id(), cwd: await $.session.cwd()}
        await $.fs.write(root + '/result.json', JSON.stringify({before, fresh, after, clear, cd}))
      } catch (error) {
        await $.fs.write(root + '/result.json', JSON.stringify({before, error: String(error)}))
      }
    })
    return {text: 'Transition probe queued'}
  })
}
"""


def interactive(arguments, cwd, env, command, done, timeout=45, confirmation=None, ready=None):
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(arguments[0], arguments, env)
    os.set_blocking(terminal, False)
    screen = b""

    def read(seconds, until=lambda: False):
        nonlocal screen
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not until():
            if select.select([terminal], [], [], 0.1)[0]:
                try:
                    screen += os.read(terminal, 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    return

    try:
        trust = lambda: b"trust" in screen and b"folder" in screen
        read(6, trust)
        if trust():
            read(2)
            os.write(terminal, b"\x1b[B")
            read(1)
            os.write(terminal, b"\r")
        read(6)
        if ready is not None:
            read(20, ready.exists)
            read(3)
        os.write(terminal, command.encode())
        read(1)
        os.write(terminal, b"\r")
        if confirmation is not None:
            read(15, lambda: confirmation.exists() or done.exists())
            if confirmation.exists():
                read(2)
                os.write(terminal, b"\r")
                # /cd asks separately before trusting the freshly mounted folder.
                # A blind second Enter chooses "No, stay put".
                def move_prompt():
                    plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", screen)
                    return b"Yes,movehere" in re.sub(rb"\s+", b"", plain)

                read(timeout, lambda: move_prompt() or done.exists())
                if move_prompt() and not done.exists():
                    os.write(terminal, b"\x1b[B")
                    read(1)
                    os.write(terminal, b"\r")
        read(timeout, done.exists)
        if not done.exists():
            raise AssertionError("Transition did not finish:\n" + screen.decode(errors="replace")[-4000:])
        read(1)
        os.write(terminal, b"/exit\r")
        read(5)
    finally:
        Path(done).with_suffix(".screen.txt").write_bytes(screen)
        try:
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and os.waitpid(pid, os.WNOHANG) == (0, 0):
                time.sleep(0.05)
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        except (ProcessLookupError, ChildProcessError):
            pass
        os.close(terminal)
    return screen


def main():
    with tempfile.TemporaryDirectory(prefix="claude-transition-") as directory:
        root = Path(directory).resolve()
        (root / "target").mkdir()
        plugin = root / "plugin"
        (plugin / ".claude-plugin").mkdir(parents=True)
        (plugin / "hooks").mkdir()
        (plugin / ".claude-plugin/plugin.json").write_text('{"name":"transition-probe","version":"0.0.1"}')
        (plugin / "hooks/hooks.json").write_text('{"modules":["./register.js"]}')
        (plugin / "hooks/register.js").write_text(HOOKS)
        result = root / "result.json"
        interactive(["claude", "--plugin-dir", str(plugin), "--tools", "",
                     "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                     "--setting-sources", "", "--debug-file", str(root / "debug.log")],
                    root, dict(os.environ, TRANSITION_ROOT=str(root)), "/transition-probe", result)
        value = json.loads(result.read_text())
        print(json.dumps(value, indent=2))
        assert "error" not in value, value
        assert value["fresh"]["id"] != value["before"]["id"], value
        assert value["after"]["id"] == value["fresh"]["id"], value
        assert value["after"]["cwd"] == str(root / "target"), value
        print("PASS fresh session ID and actual cwd after idle clear/cd")


if __name__ == "__main__":
    main()

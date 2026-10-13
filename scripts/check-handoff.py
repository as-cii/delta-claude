#!/usr/bin/env python3
"""Exercise the production hooks with real Claude requests and a disposable Delta CLI fixture.

Requires ANTHROPIC_API_KEY in the environment. Makes three small Haiku requests. Remote items
reach Claude as transcript rows the watcher adds; a restarted session must not add them again,
and a later edit must add a correction. Claude runs interactively in a pseudo-terminal, since
print mode keeps no conversation a plugin can add rows to.
It uses the current Claude installation's mod policy and a new named test session,
never joins a real Delta thread, and never copies or writes credentials. Claude
retains the test session and any records still pending in its plugin outbox.
"""

import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tempfile
import time
import uuid


FAKE_DELTA = r"""#!/usr/bin/env python3
import fcntl, json, os, pathlib, sys, time
root = pathlib.Path(os.environ["HANDOFF_PROBE_ROOT"])
args = sys.argv[1:]
THREAD = "ksQQfixture"
SHARE = "thread_fixture"
URL = "https://delta.dev/join/" + SHARE
CHECKOUT = {"directory": str(root / "project"), "state": "attached"}
REFERENCE = "00000000-0000-4000-8000-000000000001#t=0"
with (root / "commands.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")
def emit(value):
    print(json.dumps(value), flush=True)
positionals, options = [], {}
arguments = iter(args)
for argument in arguments:
    if argument == "--json":
        options[argument] = True
    elif argument.startswith("--"):
        options[argument] = next(arguments)
    else:
        positionals.append(argument)
def thread(*operations):
    return options.get("--json") is True and len(positionals) == 3 and positionals[0] == "thread" and positionals[1] in operations
def ledger():
    path = root / "ledger.json"
    return json.loads(path.read_text()) if path.exists() else {"next": 1, "records": {}, "owner": None, "turn": None, "version": 0}
def items():
    return {item["id"]: item for item in json.loads((root / "items.json").read_text())}
def common(state):
    return {"thread_id": THREAD, "url": URL, "access": {"state": "granted", "is_owner": False},
            "worktrees": {"status": "available", "items": [{"reference": REFERENCE, "checkouts": [CHECKOUT]}]},
            "producer": {"source": "claude-code", "external_id": os.environ["HANDOFF_PROBE_SESSION"],
                         "next_sequence": state["next"], "turn": state["turn"]}}
if thread("watch", "status", "append"):
    expected = {"--json": True, "--source": "claude-code", "--external-id": os.environ["HANDOFF_PROBE_SESSION"]}
    if positionals[2] != THREAD or options != expected:
        raise RuntimeError("Unexpected thread arguments: " + repr(args))
if thread("watch"):
    # Claude closes stdin after its static input; observing must not stop at EOF.
    with (root / "watch-pids").open("a") as log:
        log.write(str(os.getpid()) + "\n")
    state = ledger()
    emit({"type": "ready", "thread_id": THREAD, "producer": common(state)["producer"]})
    previous = items()
    for item in previous.values():
        emit({"type": "item", "item": item})
    emit({"type": "live"})
    previous_turn = state["turn"]
    while True:
        turn = ledger()["turn"]
        if turn != previous_turn:
            if turn:
                emit({"type": "producer.turn", **turn})
            previous_turn = turn
        current = items()
        for id, item in current.items():
            if previous.get(id) != item:
                emit({"type": "item", "item": item})
        for id in previous.keys() - current.keys():
            emit({"type": "remove", "id": id})
        previous = current
        time.sleep(0.1)
elif thread("status"):
    state = ledger()
    emit({"operation": "status", **common(state)})
elif thread("append"):
    with (root / "ledger.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = ledger()
        for line in sys.stdin:
            event = json.loads(line)
            if "turn" in event or "claim" in event or "update" not in event:
                raise RuntimeError("Append requires lifecycle or content updates, not private controls")
            sequence = event["sequence"]
            key = str(sequence)
            canonical = json.dumps(event, sort_keys=True)
            if key in state["records"]:
                if state["records"][key]["line"] != canonical:
                    raise RuntimeError("sequence reused with different content: " + key)
                accepted, duplicate = state["records"][key], True
            else:
                if sequence != state["next"]:
                    raise RuntimeError("sequence gap at " + key)
                owner = state["owner"]
                turn_sequence = event.get("turnSequence")
                update = event["update"]
                if turn_sequence is None:
                    disposition = "recorded"
                elif update["sessionUpdate"] == "state_update" and update["state"] == "running":
                    if turn_sequence != sequence:
                        raise RuntimeError("A start must reference its own sequence")
                    status = "superseded" if owner and owner["status"] == "running" else "running"
                    state["turn"] = {"sequence": sequence, "status": status}
                    disposition = "recorded" if status == "running" else "fenced"
                    if status == "running":
                        state["owner"] = dict(state["turn"])
                elif update["sessionUpdate"] == "state_update" and update["state"] == "idle":
                    disposition = "recorded"
                    if owner and owner["sequence"] == turn_sequence:
                        state["owner"] = None
                    if state["turn"] == {"sequence": turn_sequence, "status": "running"}:
                        state["turn"] = {"sequence": turn_sequence, "status": "finished"}
                else:
                    disposition = "recorded" if owner == {"sequence": turn_sequence, "status": "running"} else "fenced"
                state["version"] += 1
                accepted = {"line": canonical, "disposition": disposition, "version": "fixture-%d" % state["version"]}
                state["records"][key] = accepted
                state["next"] = sequence + 1
                duplicate = False
                with (root / "records.jsonl").open("a") as out:
                    out.write(line.strip() + "\n")
            emit({"operation": "appended", "thread_id": THREAD, "sequence": sequence,
                  "next_sequence": state["next"], "duplicate": duplicate, "version": accepted["version"],
                  "disposition": "duplicate" if duplicate else accepted["disposition"],
                  "turn_sequence": event.get("turnSequence")})
        temporary = root / "ledger.tmp"
        temporary.write_text(json.dumps(state))
        temporary.replace(root / "ledger.json")
elif "probe-watchers-stopped" in args:
    def alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
    pids = [int(line) for line in (root / "watch-pids").read_text().splitlines()]
    deadline = time.monotonic() + 0.3
    while any(alive(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(0.01)
    remaining = [pid for pid in pids if alive(pid)]
    emit({"remaining": remaining})
    sys.exit(1 if remaining else 0)
else:
    # This probe resumes a seeded binding; creation, attachment and publication are forbidden.
    if args == ["--json", "worktree", "attach", CHECKOUT["directory"], "--thread", THREAD]:
        raise RuntimeError("Resume must not attach the checkout")
    raise RuntimeError("Unexpected fixture command: " + repr(args))
"""

BOOTSTRAP = r"""
export function register(on) {
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    const root = await $.env.get('HANDOFF_PROBE_ROOT')
    const phase = await $.env.get('HANDOFF_PROBE_PHASE')
    await $.fs.write(root + '/prompt-' + phase + '.json', JSON.stringify({text: e.text, drop: result.drop}))
    return result
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const root = await $.env.get('HANDOFF_PROBE_ROOT')
    const phase = await $.env.get('HANDOFF_PROBE_PHASE')
    await $.fs.write(root + '/answer-' + phase + '.json', JSON.stringify({answer: e.answer}))
    return result
  })
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    const checked = await $.process.run(['delta', 'probe-watchers-stopped'])
    const root = await $.env.get('HANDOFF_PROBE_ROOT')
    const phase = await $.env.get('HANDOFF_PROBE_PHASE')
    await $.fs.write(root + '/lifecycle-' + phase + '.json', JSON.stringify(checked))
    return result
  })
  on('store.get', async ($, e, next) => {
    const result = await next(e)
    const session = await $.env.get('HANDOFF_PROBE_SESSION')
    if (e.key === 'session:' + session && !result.value) {
      const root = await $.env.get('HANDOFF_PROBE_ROOT')
      return {value: {session, thread: 'ksQQfixture', checkout: root + '/project',
                     snapshot: true, next: 1, pending: []}}
    }
    return result
  })
}
"""


def interactive(arguments, cwd, env, prompt, done, delivered, timeout=120):
    """Run Claude in a pseudo-terminal, submit one prompt, and exit once `done` exists and `delivered()`."""
    pid, terminal = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(arguments[0], arguments, env)
    screen = b""
    def read(seconds, until=lambda: False):
        nonlocal screen
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not until():
            if select.select([terminal], [], [], 0.1)[0]:
                try:
                    screen += os.read(terminal, 65536)
                except OSError:
                    return
    try:
        # The folder trust dialog positions each word separately.
        trust = lambda: b"trust" in screen and b"folder" in screen
        read(8, trust)
        if trust():
            # The dialog can draw again after its first frame, resetting a selection made too early.
            read(3)
            os.write(terminal, b"\x1b[B")
            read(1)
            os.write(terminal, b"\r")
        # Remote rows are added once the watcher's snapshot arrives.
        read(8)
        if os.waitpid(pid, os.WNOHANG) != (0, 0):
            raise AssertionError("Claude exited before the prompt:\n" + screen.decode(errors="replace")[-3000:])
        os.write(terminal, prompt.encode())
        read(1)
        os.write(terminal, b"\r")
        read(timeout, done.exists)
        if not done.exists():
            raise AssertionError("Claude did not finish the turn:\n" + screen.decode(errors="replace")[-3000:])
        # Exiting at once could leave the turn's finish queued for the next session.
        read(30, delivered)
        os.write(terminal, b"/exit\r")
        read(10, lambda: os.waitpid(pid, os.WNOHANG) != (0, 0))
    finally:
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        os.close(terminal)


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Supply ANTHROPIC_API_KEY in the environment; this check makes real model requests.")
    plugin = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="delta-handoff-") as directory:
        root = Path(directory)
        project = root / "project"
        project.mkdir()
        subprocess.run(["git", "init", str(project)], check=True, capture_output=True)
        (root / "bin").mkdir()
        cli = root / "bin" / "delta"
        cli.write_text(FAKE_DELTA)
        cli.chmod(0o700)
        bootstrap = root / "bootstrap"
        (bootstrap / ".claude-plugin").mkdir(parents=True)
        (bootstrap / "hooks").mkdir()
        (bootstrap / ".claude-plugin" / "plugin.json").write_text(json.dumps({
            "name": "handoff-fixture", "version": "0.0.1",
        }))
        (bootstrap / "hooks" / "hooks.json").write_text('{"modules":["./register.js"]}')
        (bootstrap / "hooks" / "register.js").write_text(BOOTSTRAP)
        env = dict(os.environ, HANDOFF_PROBE_ROOT=str(root),
                   PATH=str(root / "bin") + os.pathsep + os.environ["PATH"],
                   DELTA_DATABASE_DIR=str(root / "unused-delta-database"),
                   DELTA_REMOTE_URL="http://127.0.0.1:9")
        for key in ("DELTA_AUTH", "DELTA_IMPERSONATE", "DELTA_STATELESS"):
            env.pop(key, None)
        config = Path(env.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
        session = str(uuid.uuid4())
        env["HANDOFF_PROBE_SESSION"] = session
        def item(id, kind, author, text):
            return {"id": id, "kind": kind, "after_id": None, "turn_id": None, "author": author,
                    "created_at": 1759700000000, "open": False, "content": {"text": text}}
        messages = [
            item("question", "user_message", {"user_id": "user-anant", "name": "Anant"},
                 "Which release label did we choose?"),
            item("answer", "agent_message", {"user_id": None, "name": "Delta agent"},
                 "Release label: ORCHID-7281. Separate rollback label: CEDAR-5936."),
        ]
        cases = [
            ("What release label did Anant and the Delta agent choose? Answer only the release label.", "ORCHID-7281"),
            ("What was the separate rollback label in the earlier remote exchange? Answer only that label.", "CEDAR-5936"),
            ("What is the latest rollback label now? Answer only that label.", "MAPLE-4269"),
        ]
        for index, (prompt, expected) in enumerate(cases):
            env["HANDOFF_PROBE_PHASE"] = str(index)
            if index == 2:
                messages[1]["content"]["text"] = "The rollback label is now MAPLE-4269; the earlier choice is superseded."
            (root / "items.json").write_text(json.dumps(messages))
            interactive([
                "claude", "--plugin-dir", str(plugin), "--plugin-dir", str(bootstrap),
                "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--setting-sources", "", "--name", "Delta handoff check",
                "--debug-file", str(root / "claude-debug.log"),
                "--tools", "", "--model", "haiku",
                "--session-id" if index == 0 else "--resume", session,
            ], project, env, prompt, root / f"answer-{index}.json",
                lambda: (root / "ledger.json").exists() and json.loads((root / "ledger.json").read_text())["owner"] is None)
            lifecycle = root / f"lifecycle-{index}.json"
            if not lifecycle.exists() or json.loads(lifecycle.read_text())["exitCode"] != 0:
                raise AssertionError("Idle watcher was not stopped before Claude's session.end chain completed")
            captured = json.loads((root / f"prompt-{index}.json").read_text())
            if captured.get("drop") or captured["text"] != prompt:
                raise AssertionError(f"Prompt did not enter unchanged: {captured!r}")
            answer = json.loads((root / f"answer-{index}.json").read_text())["answer"]
            if answer.strip() != expected:
                for name in ("commands.jsonl",):
                    if (root / name).exists():
                        print(name, (root / name).read_text())
                if (root / "claude-debug.log").exists():
                    for line in (root / "claude-debug.log").read_text().splitlines():
                        if "not loaded" in line or "hook skipped" in line or "refused" in line:
                            print("Mod diagnostic:", line)
                for transcript in (config / "projects").glob(f"*/{session}.jsonl"):
                    for line in transcript.read_text().splitlines():
                        row = json.loads(line)
                        if row.get("type") == "system":
                            print("Claude diagnostic:", row.get("content"))
                raise AssertionError(f"Request {index + 1}: expected {expected}, got {answer!r}")
            print(f"PASS request {index + 1}: {expected}")
        transcripts = list((config / "projects").glob(f"*/{session}.jsonl"))
        if len(transcripts) != 1:
            raise AssertionError("Expected one disposable Claude transcript")
        rows = [json.loads(line) for line in transcripts[0].read_text().splitlines()]
        added = [row for row in rows if row.get("type") == "user" and "[Delta] " in json.dumps(row.get("message"))]
        if len(added) != 3:
            raise AssertionError(f"Expected two remote rows and one correction, found {len(added)} rows")
        if "changed an earlier agent message" not in json.dumps(added[2]["message"]):
            raise AssertionError("The edited remote answer was not added as a correction")
        records = [json.loads(line) for line in (root / "records.jsonl").read_text().splitlines()]
        starts = [record["sequence"] for record in records
                  if record.get("turnSequence") == record["sequence"]
                  and record["update"] == {"sessionUpdate": "state_update", "state": "running"}]
        finishes = [record["turnSequence"] for record in records
                    if "turnSequence" in record and record["update"] == {"sessionUpdate": "state_update", "state": "idle"}]
        if len(starts) != len(cases) or sorted(finishes) != sorted(starts):
            raise AssertionError(f"Expected one started and finished native turn per prompt: starts {starts}, finishes {finishes}")
        assistant_records = [record for record in records if record["update"]["sessionUpdate"] == "agent_message"]
        if not assistant_records or any(record.get("turnSequence") not in starts for record in assistant_records):
            raise AssertionError("Assistant output was recorded outside its actual turn lifecycle")
        user_records = [record for record in records
                        if "update" in record and record["update"]["sessionUpdate"] == "user_message"]
        if any("turnSequence" in record for record in user_records):
            raise AssertionError("A pre-turn local prompt was associated with a previous turn")
        if any("[Delta] " in json.dumps(record) for record in records):
            raise AssertionError("A remote row echoed into the outbound recording")
        for prompt, _ in cases:
            copies = sum(any(block.get("text") == prompt for block in record["update"].get("content", []))
                         for record in user_records)
            if copies != 1:
                raise AssertionError(f"Expected one recording of local prompt {prompt!r}, got {copies}")
        if len(user_records) != len(cases):
            raise AssertionError(f"Internal metadata was recorded as a user message: {len(user_records)} rows for {len(cases)} prompts")
        first_file = config / "delta-plugin" / "outbox" / session / f"{user_records[0]['sequence']}-0.json"
        if first_file.exists():
            raise AssertionError("The first durably acknowledged outbox record was not collected")
        print("PASS native turn lifecycle, remote rows without repetition after restart, edit correction, metadata filtering, echo suppression, acknowledged outbox collection, and idle-watcher shutdown")


if __name__ == "__main__":
    main()

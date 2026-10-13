# Claude Code 2.1.292: no successful session.append in the plugin test kit

The kit has no storage implementation beneath `session.append`, but also rejects
a test hook that returns the documented stored-row result without `next(e)`.
This blocks testing capture after storage and successful delivery of a remote row.
The reproduction loads no Delta code and makes no model or network requests.

From the plugin repository, run:

```sh
repro=$(mktemp -d)
mkdir -p "$repro/hooks"
printf '%s\n' '{"modules":["./register.ts"]}' > "$repro/hooks/hooks.json"
printf '%s\n' 'export function register() {}' > "$repro/hooks/register.ts"
cp scripts/session-append-repro.ts "$repro/append.test.ts"
claude --version
claude plugin test "$repro"
```

The source intentionally isn't named `*.test.ts` in this repository: these are
failing probes, not ignored regression tests or part of the plugin's normal suite.

## Observed results

On **2.1.292**, the standalone run reports **1 pass, 36 fail**, exit 1.
The probes cover all eleven declared doors, an inline plugin, and an actual
plugin call to `$.session.append({ message })`.

| Invocation | Return `{ message: e.message, uuid: e.uuid }` | Call `next(e)` | Return `{ deny: reason }` |
| --- | --- | --- | --- |
| Engine-shaped rows: `prompt`, `command`, `response`, `tool-result`, `tool-message`, `delivery`, `attachment`, `hook-context`, `compaction`, `notice` | Rejected: answer without next | No implementation | Rejected: only a plugin's own append may be refused |
| Engine-shaped `note` with plugin origin | Rejected: answer without next | No implementation | Allowed; resolves with the refusal, stores nothing |
| Actual plugin call from its command hook | No implementation | No implementation | No implementation |

For the last row, the test's append hook is not reached (the probes report its
call count). The plugin's command hook fails with `no implementation for
session.append`, is skipped, and the outer command then fails with
`no implementation for command.run`. This is distinct from the engine-shaped
`note` probe, which supplies the full append event explicitly.

An inline plugin answering an engine-shaped `prompt` is also rejected, with:

```text
append-answer's session.append hook was skipped:
append-answer: returned an answer without next (the row is kept; next(e) keeps it)
HooksError: no implementation for session.append
```

The generated `.claude-plugin/types/claude-code/index.d.ts` agrees:
`SessionAppendResult` says a hook must relay `next(e)` unchanged; only a
plugin-owned `note` may return a refusal instead. `claude-code/testing` exposes
`mock.clock`, `mock.store`, and `mock.env`, but no session-storage mock.
`PluginTier` excludes `core`, so inline test plugins cannot supply a core
implementation either. The kit's missing-implementation diagnostic nevertheless
suggests answering with `on('session.append', ...)`, which fails the guard above.

## Request to Anthropic

Please provide a kit session-storage implementation or privileged mock that
returns stored rows through the normal append guards, and adapts a plugin's
`SessionAppendArgs` call to the full `SessionAppendInput` event. Production
guards need not change.

Then Delta can test its existing live-capture contract: a prompt held until
`turn.start`, assistant rows using the active or last turn sequence, tool-result
pairing and once-only ordered export, plus successful remote-row delivery.
No production workaround was made for this kit limitation.

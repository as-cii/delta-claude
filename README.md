# Delta for Claude Code

[Delta](https://delta.dev) gives every agent thread a URL. With this plugin, your
Claude Code sessions are recorded to Delta along with the Git checkout they work
in. Anyone in your organization can then open the thread and join it, from their
own Claude Code session, from [delta.dev](https://delta.dev), or from the Delta app.

## Installation

You need Claude Code **2.1.287 or newer**. Inside Claude Code, run:

```text
/plugin marketplace add zed-industries/delta-claude
/plugin install delta@zed-industries
```

The plugin uses the `delta` CLI. If it isn't installed on macOS or Linux, the
plugin installs it the first time you share or join, and Delta opens your browser
to sign in. On Windows, install Delta from [delta.dev](https://delta.dev) first.

## Usage

### Setup

Run `/delta setup` in a repository to choose its recording policy:

- **Manual**: a session is only recorded when you run `/delta share`.
- **Private upload**: every new session is recorded automatically, and only you
  can see it until you share it.
- **Organization sharing**: every new session is recorded automatically and
  shared with your organization.

Setup writes the policy to `.delta/settings.json`. Commit that file to apply the
policy to everyone who uses the plugin in the repository.

### Commands

| Command | Description |
| --- | --- |
| `/delta share` | Share the current session and its checkout with your organization |
| `/delta join <link>` | Join a shared thread in a fresh session, in the thread's checkout |
| `/delta setup` | Choose this repository's recording policy |
| `/delta org list` | List your Delta organizations |
| `/delta org current` | Show the selected organization |
| `/delta org switch <ID>` | Select a different organization |

## Privacy

Delta stores what a recorded session contains: your conversation, including tool
inputs and outputs and Claude's thinking, plus the files in your checkout
(staged, unstaged, and untracked files that aren't ignored). Nothing is uploaded
until you share or join a session, or the repository's policy records it
automatically.

The plugin sends product telemetry to Delta: which integration ran each
command, the plugin version, and when turns start and finish and how they ended.
Telemetry events contain no messages, file paths, tool inputs, or error text.

Live activity telemetry also identifies the external source and the command-line
transport into Delta. It does not identify the person's interface. Several
updates can belong to one tool call, so event rows are not counts of tool calls
or edit operations. Historical imports do not produce these activity events.

## Development

Validate the plugin and run its tests:

```sh
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
python3 scripts/check-cli-setup.py
```

To try your changes, start Claude Code with the plugin loaded from this checkout:

```sh
claude --plugin-dir .
```

## License

Copyright (C) 2026 Zed Industries.

Licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE).

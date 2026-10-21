This repository is Delta's Claude Code plugin. See [Development](README.md#development) for
validating it, running its tests, and loading it from a checkout.

TypeScript in `hooks/` follows `.agents/skills/style-guide/SKILL.md`; read it before changing code there.

Run these checks before finishing a change. The first writes the engine types and `tsconfig.json` the type check
reads; neither is committed.

```sh
CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude -p --plugin-dir . "Load the plugin." || true
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
npx --yes --package typescript@7.0.2 tsc -p . --verbatimModuleSyntax
python3 scripts/check-cli-setup.py
```

## Landing changes

`main` is what installed plugins update from, so a commit reaches `main` only after CI has passed
on that exact commit: `main` requires the `CI Pass` check. Members of the zed-industries GitHub
organization may push a tested commit to `main` directly; everyone else opens a pull request. Read
`.agents/skills/land/SKILL.md` for the flow, including its permission gate: never modify `main`
without the user's explicit permission to land the specific change.

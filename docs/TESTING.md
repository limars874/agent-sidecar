# Testing

## Automated suites

```sh
npm ci
npm test            # node --test: runs tests/*.test.js
```

No network, Pi, Jcode or Herdr is needed. `tests/fixtures/fake-pi.js` stands in for the default Pi runner (`pi -p`; it records args including `--thinking`, prompt and the `AGENT_SIDECAR_CHILD` guard; replies with `$FAKE_PI_REPLY` or fails with `$FAKE_PI_EXIT`), `tests/fixtures/fake-jcode.js` stands in for `jcode run --json`, and `tests/fixtures/fake-herdr.js` records Herdr calls. Each test gets its own storage root in the temp directory (`tests/helpers.js` `sandbox`).

| File | Covers |
|---|---|
| `tests/items.test.js` | Markdown / YAML / JSON items, runner/effort/context fields, append/replace output modes, defaults, validation errors, skipping bad and duplicate files, global config |
| `tests/core.test.js` | Scheduler (due, idempotent, running, stale, shorter branch, success checkpoint), structured transcript projection / role filtering / budgets, session timestamp normalization/month derivation, metadata idempotence, event validation, runner/model/effort priority, Pi/Jcode model normalization, injected runner execution, context files, prompt filling, title cleaning, append/replace outputs, path templates, cross-process lock and stale-lock takeover, run staleness |
| `tests/pi-adapter.test.js` | Pi JSONL reader (active branch only, structured roles, images, creation time, header-only session info, invalid time, partial last line, missing header), default Pi runner `pi -p` arguments/effort mapping and guard, extension event building, child guard, extension → CLI → worker → runner end to end, title file → `ctx.ui.setTitle` |
| `tests/cli.test.js` | First-event metadata before any due item, `event --foreground` with title + file outputs, Herdr call, scheduled/completed cursors, retry after failure, job cleanup, idempotence; replace snapshot repetition and append duplicate semantics; month-based outputs/metadata and legacy-path behavior; session-model fallback; Pi and Jcode runners; effort forwarding; "no model"; detached `event`; invalid input exit codes; script items; `run` and `--dry-run`; `items`; shipped examples |

`tests/fixtures/pi-session.jsonl` is a Pi v3 session with an abandoned branch, tool calls, an image and a half-written last line.

## Live check with a real Pi

Do this in a throwaway storage root, so nothing touches your real `~/.agent-sidecar`, and without installing the extension globally:

```sh
export AGENT_SIDECAR_HOME=$(mktemp -d)
mkdir -p $AGENT_SIDECAR_HOME/items
cat > $AGENT_SIDECAR_HOME/items/title.md <<'EOF'
---
everyTurns: 1
context: session
output: title
---
Write a title of at most 6 words for this session. Reply with the title only.
EOF
cat > $AGENT_SIDECAR_HOME/items/summary.yaml <<'EOF'
everyTurns: 1
context:
  scope: delta
  include: [user, assistant]
  maxChars: 12000
output:
  file: out/{agent}/{sessionMonth}/{session}/summary.md
  mode: replace
prompt: Summarize the conversation below in 2 bullets.
EOF

SESS=$(mktemp -d)
pi -p --session-dir "$SESS" -e "$PWD/adapters/pi/extension.js" "Say hello in one word."
sleep 30   # side work runs detached
cat $AGENT_SIDECAR_HOME/state/pi/*/runs.jsonl $AGENT_SIDECAR_HOME/state/pi/*/title.txt $AGENT_SIDECAR_HOME/out/pi/*/*/metadata.json $AGENT_SIDECAR_HOME/out/pi/*/*/summary.md
```

Expected: two `"status":"ok"` runs whose `model` is the session's model, a title, and a summary. In print mode the extension has no UI, so the terminal title is not set; in an interactive `pi` inside Herdr, the pane title should change after the first turn.

Manual runner over an existing session file:

```sh
node bin/agent-sidecar.js run summary --agent pi --session "$(ls -t $SESS/*.jsonl | head -1)" --dry-run
```

# Testing

## Automated suites

```sh
npm ci
npm test            # node --test: runs tests/*.test.js
```

No network, Pi or Herdr is needed. `tests/fixtures/fake-pi.js` stands in for `pi -p` (records args, prompt and the `AGENT_SIDECAR_CHILD` guard; replies with `$FAKE_PI_REPLY` or fails with `$FAKE_PI_EXIT`), `tests/fixtures/fake-herdr.js` records Herdr calls. Each test gets its own storage root in the temp directory (`tests/helpers.js` `sandbox`).

| File | Covers |
|---|---|
| `tests/items.test.js` | Markdown / YAML / JSON items, defaults, every validation error, skipping bad and duplicate files, global config |
| `tests/core.test.js` | Scheduler (due, idempotent, running, stale, shorter branch), transcript slicing / rendering / truncation, event validation, model priority, prompt filling, title cleaning, path templates, cross-process lock and stale-lock takeover, run staleness |
| `tests/pi-adapter.test.js` | Pi JSONL reader (active branch only, roles, images, partial last line, missing header), `pi -p` arguments and guard, extension event building, child guard, extension → CLI → worker → `pi -p` end to end, title file → `ctx.ui.setTitle` |
| `tests/cli.test.js` | `event --foreground` with title + file outputs, Herdr call, cursors, job cleanup, idempotence; session-model fallback; failure recording; "no model"; detached `event`; invalid input exit codes; script items; `run` and `--dry-run`; `items`; shipped examples |

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
output:
  file: out/{agent}/{session}/summary.md
prompt: Summarize the conversation below in 2 bullets.
EOF

SESS=$(mktemp -d)
pi -p --session-dir "$SESS" -e "$PWD/adapters/pi/extension.js" "Say hello in one word."
sleep 30   # side work runs detached
cat $AGENT_SIDECAR_HOME/state/pi/*/runs.jsonl $AGENT_SIDECAR_HOME/state/pi/*/title.txt $AGENT_SIDECAR_HOME/out/pi/*/summary.md
```

Expected: two `"status":"ok"` runs whose `model` is the session's model, a title, and a summary. In print mode the extension has no UI, so the terminal title is not set; in an interactive `pi` inside Herdr, the pane title should change after the first turn.

Manual runner over an existing session file:

```sh
node bin/agent-sidecar.js run summary --agent pi --session "$(ls -t $SESS/*.jsonl | head -1)" --dry-run
```

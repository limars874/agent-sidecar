# Testing

## Automated suites

```sh
npm ci
npm test            # node --test: runs tests/*.test.js
```

No network, Pi, Jcode, Herdr or NATS is needed for the automated suite. `tests/fixtures/fake-pi.js` stands in for the default Pi runner (`pi -p`; it records args including `--thinking`, prompt and the `AGENT_SIDECAR_CHILD` guard; replies with `$FAKE_PI_REPLY` or fails with `$FAKE_PI_EXIT`), `tests/fixtures/fake-jcode.js` stands in for `jcode run --json`, and `tests/fixtures/fake-herdr.js` records Herdr calls. NATS publisher and Pi subscription tests use injected mock clients. Each test gets its own storage root in the temp directory (`tests/helpers.js` `sandbox`).

| File | Covers |
|---|---|
| `tests/items.test.js` | Markdown / YAML / JSON items, runner/effort/context fields, append/replace output modes, defaults, validation errors, skipping bad and duplicate files, global config |
| `tests/core.test.js` | Scheduler (due, idempotent, running, stale, shorter branch, success checkpoint), structured transcript projection / role filtering / budgets, session timestamp normalization/month derivation, metadata idempotence, event and feedback/handoff-route validation, bounded feedback/handoff envelopes, injected NATS publication and transport warnings, idle-handoff state transitions, one-plan-per-progress, same-plan retry after unknown publish results, cancel-then-schedule timeout, lifecycle reordering and duplicate events, runner/model/effort priority, Pi/Jcode model normalization, injected runner execution, context files, prompt filling, title cleaning, append/replace outputs, path templates, cross-process lock and stale-lock takeover, run staleness |
| `tests/pi-adapter.test.js` | Pi JSONL reader (active branch only, structured roles, images, creation time, header-only session info, invalid time, partial last line, missing header), default Pi runner `pi -p` arguments/effort mapping and guard, extension event building, child guard, extension → CLI → worker → runner end to end, mock NATS feedback/handoff subscriptions, instance/session/progress validation, active-vs-idle `sendMessage`, `triggerTurn` wake and handoff lifecycle classification, session-switch cleanup, title file → `ctx.ui.setTitle` |
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

## Live feedback smoke check with Pi + NATS

This check requires a local core NATS server and an authenticated URL if the server requires credentials. Keep the URL only in the throwaway config; never commit credentials.

1. Create a throwaway `AGENT_SIDECAR_HOME`, copy `examples/items/review.md` (or add `feedback: true` to one test item), and set `feedback.natsUrl` in its config. Keep only one small feedback item enabled.
2. Start an interactive Pi session with the adapter package loaded and send enough turns for the item to run.
3. Confirm `runs.jsonl` contains `status: "ok"` with any transport warning separate from the item status, and ask the same Pi session what feedback it received. Verify that the message is advisory, arrives without an automatically triggered idle turn, and does not create a second sidecar event.
4. Stop/restart NATS and repeat once: Pi remains usable, the item output/checkpoint still completes, and a bounded feedback warning is recorded.

The repository's automated tests cover the same routing and delivery decisions with mocks; this real smoke test is the required network/lifecycle check.

A Pi 0.84.4 API probe also verified the delivery contract: `sendMessage(..., { deliverAs: "steer" })` was accepted while `ctx.isIdle()` was `false` and persisted a custom message without interrupting the in-flight request; `nextTurn` was accepted while idle and did not start an automatic turn; a subsequent user prompt received it. A separate `newSession()` probe observed `session_shutdown` for the old id, then `session_start` and `withSession` for a distinct new id, so session-scoped routes must be recreated and stale messages dropped. A real temporary NATS server was stopped and restarted; the existing subscription received a message after the client automatically reconnected, confirming subscription recovery rather than only terminal-close/recreate behavior.

## Live idle-handoff smoke check with NATS 2.15 + Pi

This check is required for a handoff implementation because mocks cannot prove JetStream scheduling, consumer delivery and Pi's active-wake behavior together.

1. Use a throwaway `AGENT_SIDECAR_HOME` and config with `idleHandoff.enabled: true`, a short `after` such as `5s`, and the real local NATS 2.15 URL. Do not modify the user's resident config for a branch smoke.
2. Start a fresh interactive Pi process with the branch's `adapters/pi/extension.js`, disable ordinary items, and send one simple prompt that finishes without tools. Confirm the first event creates a scheduled handoff and state records the normal work progress.
3. Wait beyond the deadline while Pi is idle. Confirm `runs.jsonl`/`sidecar.log` show the handoff route without an item job, the session JSONL contains an `agent-sidecar-handoff` custom message, and Pi starts exactly one new agent turn. Ask the agent to report the handoff decision; it may say that it wrote nothing.
4. Confirm the triggered and completed handoff events do not schedule a new plan. Send another normal user turn and verify the previous schedule is cancelled/replaced, then stop/restart NATS before the next deadline and verify reconnect handling is explicit rather than silently falling back to polling. For a deterministic failure check, use the injected tests to make cancellation succeed while schedule acknowledgement times out; the plan must remain pending with the same id.
5. Repeat with a stale or mismatched `progressId` and confirm the delayed message is dropped without waking the wrong session.

Expected: one eligible normal work batch creates at most one check; an unknown publish result does not allocate a new plan id; completion-before-trigger and duplicate lifecycle events do not corrupt state; the check actively wakes only the original idle Pi instance; no sidecar daemon, terminal injection, feedback message or self-loop appears. Record the NATS server version and the session JSONL path in the test report without committing credentials.

A real NATS 2.15 cancellation/dedup race was also verified on an ephemeral `nats-server -js`: the old plan was published, replacement cancellation succeeded, the replacement schedule was accepted while its ACK was deliberately withheld, and the retry repeated the old cancellation plus the same replacement `msgID`. The replacement used a distinct plan-specific schedule subject and delivered exactly one `plan-new` message after the retry (`PASS`, NATS 2.15.0). This guards against a retry purge targeting the replacement schedule.

Manual runner over an existing session file:

```sh
node bin/agent-sidecar.js run summary --agent pi --session "$(ls -t $SESS/*.jsonl | head -1)" --dry-run
```

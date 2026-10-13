# Architecture

## Components

```
adapters/pi/extension.js   in Pi's process: clears lifecycle titles, builds events, starts the CLI, applies titles
        │  agent-sidecar event --json {...}          (detached, fire and forget)
        ▼
bin/agent-sidecar.js       argument parsing, exit codes
host/commands.js           CLI host: event, work, run, items
        │                     uses
        ├── core/          agent-neutral library
        │     event.js       event validation (CONTRACT §1)
        │     items.js       item loading and validation (§3)      files.js  YAML / JSON / frontmatter parsing
        │     config.js      global config (§4)
        │     scheduler.js   which items are due (pure function)
        │     state.js       state.json, session lock, run staleness, append helpers
        │     transcript.js  turn counting, slicing, rendering for prompts
        │     runner.js      model choice, prompt filling, prompt/script execution
        │     session.js     creation-time validation and stable session context
        │     outputs.js     title / file / metadata / none (§5)
        │     feedback.js    NATS feedback envelope and best-effort publication
        │     idle-handoff.js JetStream delayed plans, cancellation and handoff state machine
        │     paths.js       storage layout (§6)
        ├── runners/        one-shot model CLI backends, registered in runners/index.js
        │     index.js       runner selection and default (`pi`)
        │     pi.js          `pi -p` model calls
        │     jcode.js       `jcode run --json` model calls
        └── adapters/       one directory per observed agent, registered in adapters/index.js
              pi/index.js        { name, readSessionInfo, readTranscript }
              pi/transcript.js   Pi session JSONL → neutral transcript + createdAt
              pi/extension.js    optional feedback/handoff subscriptions and Pi message injection
```

Dependency direction: `bin → host → core + adapters + runners`; adapters read agent-specific sessions, runners execute one-shot model CLIs, and `core` remains independent from both registries. The Pi extension imports only the path/output/config/item/feedback/idle-handoff pieces it needs for lifecycle, optional NATS subscriptions and event emission; it loads the small YAML parser and NATS transport but no model-runner code.

## Data flow of one turn

1. Pi fires `session_start` when a session starts or changes. For `new` and `resume`, the extension reads the global lifecycle policy and, when enabled, clears the pane label and the sidecar-owned Herdr metadata title. A configured resume cleanup also suppresses the immediate restoration of that session's saved terminal title. When `idleHandoff.enabled` is true, it creates a session-scoped JetStream route and push consumer after startup; no socket or timer is started from the extension factory.
2. Pi fires `agent_settled` (the run is fully done: no retry, compaction or queued message left). If it was not aborted, the extension builds the event from `ctx`: session id and file from `ctx.sessionManager`, model from `ctx.model`, pane from `$HERDR_PANE_ID`, turn = user messages on `getBranch()`, `progressId` = the latest user entry id, and the ephemeral feedback/handoff routes when enabled. The extension subscribes before emitting the first event. A handoff-triggered turn is identified separately and never becomes normal work.
3. It spawns `node bin/agent-sidecar.js event --json <event>` detached with stdio ignored. Pi never waits for sidecar model work; only bounded NATS setup may be awaited so the first route is ready. Feedback validation calls `sendMessage()` with `deliverAs: "steer"` while active or `"nextTurn"` while idle and never uses `triggerTurn`. Handoff validation additionally requires idle Pi plus matching current work turn and `progressId`, then calls `sendMessage()` with `deliverAs: "steer"` and `triggerTurn: true` to start exactly one judgment turn.
4. `event` validates the event, reads only the agent session header, derives the immutable `createdAt`/UTC `sessionMonth` context, and atomically publishes canonical `out/<agent>/<sessionMonth>/<session>/metadata.json` on the first valid observation. For `work`, it takes the session lock and runs `planEvent` plus the idle-handoff state machine: a new eligible progress cancels the prior JetStream schedule and creates one replacement after `idleHandoff.after`. The lock remains held across the bounded cancel/publish call, and a pending plan is persisted first. If cancellation or scheduling has an unknown result, state remains pending and the same plan id is retried; a later progress supersedes it. Handoff lifecycle events only mark state and never schedule ordinary items.
5. If an item is due, `event` writes `jobs/<job>.json` and spawns `agent-sidecar work <job>` detached, with stdout/stderr going to `sidecar.log`. A handoff schedule is handled in the same event process through bounded JetStream calls and does not create an item job. Then the event process exits.
6. `work` records its pid in the `running` markers, reads the full transcript once, and rechecks metadata as an idempotent fallback. It then runs the job's items one after another: resolve the item/global runner (default `pi`) and effort, select the context scope/roles/files and budget, fill the prompt, call that runner (or run the script), and apply the output. For `feedback: true`, a successful non-empty result is published as a bounded advisory envelope after output application; connection or delivery failures are warnings only. File outputs can append activity records or atomically replace current-state snapshots. After each item it appends the selected runner, effort and warnings to `runs.jsonl` and, under the lock, clears `running`, stores `lastRun`, and advances `completedThrough` only after success. Finally it removes the job file.
7. When a delayed handoff arrives, the extension appends a `triggered` marker, wakes the idle Pi agent and reports `handoff-triggered`; the resulting `agent_settled` reports `handoff`, completes the plan and does not schedule items or re-arm the timer. The agent itself decides whether to write or update a Handoff document; the sidecar never fabricates one.
8. If an item wrote `title.txt`, the extension (which polls that file once a second) calls `ctx.ui.setTitle`. Herdr's pane title was already set in step 6.

## Why two detached hops

`event` must be quick and safe to call from any hook, including future hook-based agents whose hooks block the agent until they exit. Scheduling (validation, lock, state) is fast; model calls are not. So `event` finishes in milliseconds and the slow part runs in `work`, a separate detached process that outlives both the agent's hook and the `event` process.

## State and concurrency

- No process keeps state in memory across events. Everything lives in `state/<agent>/<session>/` (CONTRACT §6).
- Every read-modify-write of `state.json` happens under the session's lock file; writes go through a temp file and `rename`.
- `scheduledThrough` moves when a run is scheduled, while `completedThrough`/`lastTurn` move only after success. Two quick events therefore cannot schedule the same turns twice, and failed work remains retryable instead of silently losing its delta.
- Execution is at-least-once: output is applied before the completion checkpoint, so a crash in that small window can repeat a range. `replace` snapshots normally tolerate this; `append` outputs may duplicate records.
- One item never runs twice at once in a session (the `running` marker). Different items, and different sessions, run in parallel. Idle-handoff plan publication is serialized per session by the same lock; it is deliberately not a detached job because cancel-then-replace must not race another work event.
- Crashed workers are detected by a dead pid or a 30-minute age; the item is then scheduled again on the next due event. Metadata creation is independently idempotent: an existing file is never rewritten.
- Feedback is deliberately non-authoritative: it has no effect on output/checkpoint success, uses one bounded publish attempt, and has no persistence or resend queue. The extension only starts the NATS connection after `session_start`, tears it down on `session_shutdown`, and suppresses it in child/disabled processes.
- Idle handoff is separately opt-in and stateful per session. JetStream stores the one-shot schedule; each normal work progress cancels and rebuilds it. Unknown cancel/schedule outcomes retain the deterministic plan id for retry rather than silently allocating a new id. Expiry is revalidated against the target session, turn and progress id, and stale messages are dropped. Trigger and completion events are idempotent, including completion arriving before the detached trigger event. A triggered check and its completion are tracked separately from whether the agent wrote a document. There is no polling, cron, daemon or terminal-key fallback, and the handoff message type never enters Feedback V1's route.

## Adding an agent adapter

1. Add `adapters/<agent>/index.js` exporting `{ name, readSessionInfo, readTranscript }` (CONTRACT §2), then register it in `adapters/index.js`.
2. Add a lightweight header reader for `readSessionInfo`, plus a full reader producing the neutral transcript (active branch, roles `user`/`assistant`/`toolCall`/`toolResult`). Keep tool calls separate so context projections can filter them.
3. Add the in-agent hook or extension that sends the event when a turn has finished. If the agent cannot set its own title from inside, `title` output still reaches Herdr panes through `pane`.
4. Add tests: a fixture session file, reader tests, and an end-to-end `event --foreground` test like `tests/cli.test.js`.

## Adding a model runner

1. Add `runners/<runner>.js` exporting `{ name, callModel({ model, effort, prompt, timeoutMs, env }) }` (CONTRACT §2.1), then register it in `runners/index.js`.
2. Implement the agent's one-shot CLI invocation, map the normalized `effort` to its own flag or argument when supported, handle stdin/stdout, timeout and non-zero exit errors. A runner may deliberately use its own config for effort when the CLI has no per-call option. Disable hooks/extensions in the child when needed to prevent recursion.
3. Select it with the global `runner` config or an item's `runner` field. The observed agent adapter does not need to change.
4. Add runner tests using a fake executable; the existing Pi runner test is in `tests/pi-adapter.test.js` for historical grouping.

Adding either kind of integration leaves the other boundary unchanged. Adding an agent also makes its name valid to `validateEvent`; adding a runner only changes runner selection. Context projection and output mode remain shared core behavior.

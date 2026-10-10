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
        │     outputs.js     title / file / none (§5)
        │     paths.js       storage layout (§6)
        ├── runners/        one-shot model CLI backends, registered in runners/index.js
        │     index.js       runner selection and default (`pi`)
        │     pi.js          `pi -p` model calls
        │     jcode.js       `jcode run --json` model calls
        └── adapters/       one directory per observed agent, registered in adapters/index.js
              pi/index.js        { name, readTranscript }
              pi/transcript.js   Pi session JSONL → neutral transcript
```

Dependency direction: `bin → host → core + adapters + runners`; adapters read agent-specific sessions, runners execute one-shot model CLIs, and `core` remains independent from both registries. The Pi extension imports `core/paths.js`, `core/outputs.js` and `core/config.js`; loading it in Pi pulls in the small YAML config parser but no item or model-runner code.

## Data flow of one turn

1. Pi fires `session_start` when a session starts or changes. For `new` and `resume`, the extension reads the global lifecycle policy and, when enabled, clears the pane label and the sidecar-owned Herdr metadata title. A configured resume cleanup also suppresses the immediate restoration of that session's saved terminal title.
2. Pi fires `agent_settled` (the run is fully done: no retry, compaction or queued message left). If it was not aborted, the extension builds the event from `ctx`: session id and file from `ctx.sessionManager`, model from `ctx.model`, pane from `$HERDR_PANE_ID`, turn = user messages on `getBranch()`.
3. It spawns `node bin/agent-sidecar.js event --json <event>` detached with stdio ignored, and returns. Pi never waits.
4. `event` validates the event, loads the items, takes the session lock, runs `planEvent` on `state.json`, saves the new state (`scheduledThrough` and `running` markers set), releases the lock.
5. If something is due, it writes `jobs/<job>.json` and spawns `agent-sidecar work <job>` detached, with stdout/stderr going to `sidecar.log`. Then it exits.
6. `work` records its pid in the `running` markers, reads the transcript once, and runs the job's items one after another: resolve the item/global runner (default `pi`) and effort, select the context scope/roles/files and budget, fill the prompt, call that runner (or run the script), and apply the output. File outputs can append activity records or atomically replace current-state snapshots. After each item it appends the selected runner and effort to `runs.jsonl` and, under the lock, clears `running`, stores `lastRun`, and advances `completedThrough` only after success. Finally it removes the job file.
7. If an item wrote `title.txt`, the extension (which polls that file once a second) calls `ctx.ui.setTitle`. Herdr's pane title was already set in step 6.

## Why two detached hops

`event` must be quick and safe to call from any hook, including future hook-based agents whose hooks block the agent until they exit. Scheduling (validation, lock, state) is fast; model calls are not. So `event` finishes in milliseconds and the slow part runs in `work`, a separate detached process that outlives both the agent's hook and the `event` process.

## State and concurrency

- No process keeps state in memory across events. Everything lives in `state/<agent>/<session>/` (CONTRACT §6).
- Every read-modify-write of `state.json` happens under the session's lock file; writes go through a temp file and `rename`.
- `scheduledThrough` moves when a run is scheduled, while `completedThrough`/`lastTurn` move only after success. Two quick events therefore cannot schedule the same turns twice, and failed work remains retryable instead of silently losing its delta.
- One item never runs twice at once in a session (the `running` marker). Different items, and different sessions, run in parallel.
- Crashed workers are detected by a dead pid or a 30-minute age; the item is then scheduled again on the next due event.

## Adding an agent adapter

1. Add `adapters/<agent>/index.js` exporting `{ name, readTranscript }` (CONTRACT §2), then register it in `adapters/index.js`.
2. Add a reader for that agent's session format producing the neutral transcript (active branch, roles `user`/`assistant`/`toolCall`/`toolResult`). Keep tool calls separate so context projections can filter them.
3. Add the in-agent hook or extension that sends the event when a turn has finished. If the agent cannot set its own title from inside, `title` output still reaches Herdr panes through `pane`.
4. Add tests: a fixture session file, reader tests, and an end-to-end `event --foreground` test like `tests/cli.test.js`.

## Adding a model runner

1. Add `runners/<runner>.js` exporting `{ name, callModel({ model, effort, prompt, timeoutMs, env }) }` (CONTRACT §2.1), then register it in `runners/index.js`.
2. Implement the agent's one-shot CLI invocation, map the normalized `effort` to its own flag or argument when supported, handle stdin/stdout, timeout and non-zero exit errors. A runner may deliberately use its own config for effort when the CLI has no per-call option. Disable hooks/extensions in the child when needed to prevent recursion.
3. Select it with the global `runner` config or an item's `runner` field. The observed agent adapter does not need to change.
4. Add runner tests using a fake executable; the existing Pi runner test is in `tests/pi-adapter.test.js` for historical grouping.

Adding either kind of integration leaves the other boundary unchanged. Adding an agent also makes its name valid to `validateEvent`; adding a runner only changes runner selection. Context projection and output mode remain shared core behavior.

# Architecture

## Components

```
adapters/pi/extension.js   in Pi's process: builds events, starts the CLI, applies titles
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
        └── adapters/      one directory per agent, registered in adapters/index.js
              pi/index.js        { name, readTranscript, callModel }
              pi/transcript.js   Pi session JSONL → neutral transcript
              pi/model.js        pi -p model calls
```

Dependency direction: `bin → host → core + adapters`; `adapters → core` (helpers only); `core` imports nothing from `host` or `adapters`. The Pi extension imports only `core/paths.js` and `core/outputs.js` (for the title file name), so loading it in Pi pulls in no YAML parser and no item code.

## Data flow of one turn

1. Pi fires `agent_settled` (the run is fully done: no retry, compaction or queued message left). If it was not aborted, the extension builds the event from `ctx`: session id and file from `ctx.sessionManager`, model from `ctx.model`, pane from `$HERDR_PANE_ID`, turn = user messages on `getBranch()`.
2. It spawns `node bin/agent-sidecar.js event --json <event>` detached with stdio ignored, and returns. Pi never waits.
3. `event` validates the event, loads the items, takes the session lock, runs `planEvent` on `state.json`, saves the new state (cursors moved, `running` markers set), releases the lock.
4. If something is due, it writes `jobs/<job>.json` and spawns `agent-sidecar work <job>` detached, with stdout/stderr going to `sidecar.log`. Then it exits.
5. `work` records its pid in the `running` markers, reads the transcript once, and runs the job's items one after another: render the turn slice, fill the prompt, call `pi -p` (or run the script), apply the output. After each item it appends to `runs.jsonl` and, under the lock, clears `running` and stores `lastRun`. Finally it removes the job file.
6. If an item wrote `title.txt`, the extension (which polls that file once a second) calls `ctx.ui.setTitle`. Herdr's pane title was already set in step 5.

## Why two detached hops

`event` must be quick and safe to call from any hook, including future hook-based agents whose hooks block the agent until they exit. Scheduling (validation, lock, state) is fast; model calls are not. So `event` finishes in milliseconds and the slow part runs in `work`, a separate detached process that outlives both the agent's hook and the `event` process.

## State and concurrency

- No process keeps state in memory across events. Everything lives in `state/<agent>/<session>/` (CONTRACT §6).
- Every read-modify-write of `state.json` happens under the session's lock file; writes go through a temp file and `rename`.
- An item's cursor (`lastTurn`) moves when its run is scheduled. Two quick events therefore cannot schedule the same turns twice, and a slow run cannot block later scheduling for longer than its own `running` marker lasts.
- One item never runs twice at once in a session (the `running` marker). Different items, and different sessions, run in parallel.
- Crashed workers are detected by a dead pid or a 30-minute age; the item is then scheduled again on the next due event.

## Adding an agent

1. `adapters/<agent>/index.js` exporting `{ name, readTranscript, callModel }` (CONTRACT §2), registered in `adapters/index.js`.
2. A reader for that agent's session format producing the neutral transcript (active branch, roles `user`/`assistant`/`tool`).
3. A model backend: usually the agent's own headless mode (e.g. `claude -p`, `codex exec`), with the agent's hooks/extensions disabled in that child.
4. The in-agent part: a hook or extension that sends the event when a turn has finished. For hook-only agents this is a few lines of shell that pipe the event into `agent-sidecar event`. If the agent cannot set its own title from inside, `title` output still reaches Herdr panes through `pane`.
5. Tests: a fixture session file, reader tests, and an end-to-end `event --foreground` test like `tests/cli.test.js`.

Nothing in `core/` or `host/` changes, except that `validateEvent` learns the new name from the registry automatically.

# agent-sidecar contract

This file is the authoritative definition of everything that crosses a boundary in agent-sidecar: the event an adapter sends, the adapter interface, item and config files, outputs, the storage tree and the CLI. Code that disagrees with it is a bug. Version: **event v1**.

## 1. Event

An adapter reports each finished turn of an agent session as one JSON object, passed to `agent-sidecar event` (as `--json <text>` or on stdin).

```json
{
  "v": 1,
  "agent": "pi",
  "session": "0199a3f2-…",
  "transcriptRef": "/Users/me/.pi/agent/sessions/…/2026-10-09T10-00-00_0199a3f2-….jsonl",
  "model": "anthropic/claude-sonnet-4-5",
  "pane": "w1:p4",
  "turn": 7
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | `1` | yes | Event version. Other values are rejected. |
| `agent` | string | yes | Adapter name (a key of `adapters/index.js`). v1 knows only `pi`. |
| `session` | non-empty string | yes | The agent's own session id. Used as the storage namespace. |
| `transcriptRef` | non-empty string | yes | Where the adapter can read the transcript. For Pi: the session `.jsonl` path. The core never interprets it; only the adapter does. |
| `model` | string or null | no | The session's current model, in the form the adapter's `callModel` accepts (Pi: `provider/id`). Last fallback for model choice. |
| `pane` | string or null | no | Herdr pane id when the agent runs inside Herdr (`$HERDR_PANE_ID`). Enables Herdr title updates. |
| `turn` | integer ≥ 0 or null | no | Number of user turns on the session's active branch, including the one just finished. When missing, the CLI counts the turns in the transcript. |

**Turn**: one user prompt and everything the agent did for it, until the agent is fully idle again. Model calls inside tool loops are not separate turns. A turn ends when the agent has settled (Pi: `agent_settled`). Aborted runs (Esc) are not reported.

**Idempotence**: reporting the same `turn` twice schedules nothing the second time, because items run only when `turn` has moved at least `everyTurns` past their last run.

## 2. Adapters

An adapter is one entry in `adapters/index.js`:

```js
{
  name: 'pi',
  readTranscript(transcriptRef) → { session, cwd, model, messages: [{ role, text, name? }] },
  callModel({ model, prompt, timeoutMs, env }) → string,
}
```

- `readTranscript` returns the session's **active branch** only, oldest first. `role` is `user`, `assistant` or `tool`. A turn starts at each `user` message. `name` is the tool name for `tool` messages. Assistant tool calls are rendered into the assistant's `text` (Pi: `→ bash {"command":"ls"}`). Hidden reasoning is left out.
- `model` is the session's current model as far as the transcript shows it (Pi: the latest model switch or assistant reply on the branch), or null. `agent-sidecar run` uses it as the session model when `--model` is not given.
- `callModel` makes one non-interactive call with no tools and returns the reply text. It must not trigger the adapter's own event reporting (Pi: `--no-extensions` plus `AGENT_SIDECAR_CHILD=1`).
- Both run synchronously inside a short-lived CLI process.

The in-agent half of an adapter (Pi: `adapters/pi/extension.js`) only builds events, starts `agent-sidecar event`, and, if the agent can set its own terminal title, applies `title.txt` (see §5).

## 3. Items

Items live in `<root>/items/`. Each `.md`, `.yaml`, `.yml` or `.json` file is one item; other files (scripts, notes) are ignored. Files are read in name order on every event, so edits take effect on the next turn with no reload.

### Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `[A-Za-z0-9._-]+` | file name without extension | Unique item name. Used in state and output paths. |
| `everyTurns` | integer ≥ 1 | required | Run when at least this many turns passed since the item's last run. |
| `model` | string | none | Model for this item (see §3.3). |
| `prompt` | string | — | A prompt for the model. Exactly one of `prompt` / `script`. |
| `script` | string | — | A shell command (`/bin/sh -c`), run in the items directory. Exactly one of `prompt` / `script`. |
| `context` | `delta` \| `session` | `delta` | `delta`: turns since the item's last run. `session`: the whole active branch. |
| `output` | `title` \| `none` \| `{ file: <path template> }` | `none` | Where the result goes (§5). |

Unknown keys are errors (to catch typos such as `every_turns`). An invalid file is skipped with a message in the session's `sidecar.log` and in `agent-sidecar items`; the other items still run.

### 3.1 Formats

Markdown: YAML frontmatter holds the fields; the body is the prompt. A body and a frontmatter `prompt` together are an error. A Markdown file with an empty body must set `script` or `prompt` in the frontmatter.

```markdown
---
everyTurns: 2
context: session
output: title
---
Write a title of at most 6 words for this session.

{{transcript}}
```

YAML / JSON: the same fields as a mapping. In YAML, write `output` as a block mapping (below) or quote the path (`output: { file: "out/{agent}.md" }`): unquoted `{…}` placeholders are YAML flow syntax and fail to parse.

```yaml
everyTurns: 3
model: anthropic/claude-haiku-4-5
output:
  file: out/{agent}/{session}/summary.md
prompt: |
  Summarize turns {{fromTurn}}+1 to {{toTurn}} as bullets.
  {{transcript}}
```

### 3.2 Prompt placeholders

`{{transcript}}`, `{{agent}}`, `{{session}}`, `{{item}}`, `{{turn}}` (= `toTurn`), `{{fromTurn}}`, `{{toTurn}}`, `{{cwd}}` (the session's working directory if the transcript has one). Unknown placeholders are left as written. If the prompt has no `{{transcript}}`, the transcript is appended inside `<transcript>…</transcript>`.

The transcript covers turns `fromTurn+1 … toTurn`. Tool results are cut to `toolResultLines` lines each. If the rendered text is longer than `maxTranscriptChars`, the oldest part is cut and replaced by a marker.

### 3.3 Model choice

1. the item's `model`, else
2. the global `model` in config, else
3. the event's `model` (the session's current model), else
4. the run fails with "no model" (prompt items only).

Script items get the chosen model in their input but do not have to use it.

### 3.4 Script input and result

The script receives one JSON object on stdin:

```json
{ "transcript": "…", "agent": "pi", "session": "…", "item": "count", "turn": 7, "fromTurn": 4, "toTurn": 7,
  "cwd": "/work/demo", "model": "anthropic/…", "event": { … }, "root": "/Users/me/.agent-sidecar" }
```

Its stdout is the result, sent to the item's `output`. A non-zero exit or a timeout (`timeoutMs`) fails the run. The script runs with the CLI's environment.

## 4. Global config

Optional, in `<root>/config.yaml`, `config.yml` or `config.json` (only one may exist). Unknown keys are errors.

| Key | Default | Meaning |
|---|---|---|
| `model` | none | Global default model. |
| `timeoutMs` | `120000` | Limit per model call or script. |
| `maxTranscriptChars` | `60000` | Size cap of `{{transcript}}`. |
| `toolResultLines` | `20` | Lines kept per tool result. |

## 5. Outputs

| `output` | Effect |
|---|---|
| `none` | Result discarded (a script that writes its own files). |
| `title` | First non-empty line of the result, stripped of quotes and `#`, at most 80 characters. Written to `state/<agent>/<session>/title.txt`. If the event has a `pane`, also `herdr pane report-metadata <pane> --source agent-sidecar --title <title>` (`$HERDR_BIN_PATH` or `herdr`). An adapter that can set its own terminal title watches `title.txt` and applies it (Pi does). An empty title writes nothing. |
| `{ file: <template> }` | Appends `## <ISO time> · <item> · <agent> <session> · turns <from+1>–<to>`, a blank line and the result. An empty result appends nothing (so a knowledge item can answer with nothing). |

Path template placeholders: `{agent}`, `{session}`, `{item}`, `{date}` (local `YYYY-MM-DD`). Any other `{…}` is an error. `~/` expands to `$HOME`; relative paths are relative to the storage root. `{agent}` and `{session}` are made safe for one path segment.

## 6. Storage

One tree for every agent. Root: `$AGENT_SIDECAR_HOME`, default `~/.agent-sidecar`.

```
<root>/
  config.yaml                      global config (optional)
  items/                           item definitions
  out/                             default place for file outputs (by convention: out/<agent>/<session>/…)
  state/<agent>/<session>/
    state.json                     cursors and running markers (below)
    lock                           held while state.json is read and written
    title.txt                      latest title
    jobs/<job>.json                scheduled work not yet finished
    runs.jsonl                     one line per item run
    sidecar.log                    errors, warnings, worker output
```

`state.json`:

```json
{ "v": 1, "items": { "summary": { "lastTurn": 6,
    "running": { "job": "1791…-a1b2c3", "pid": 4242, "since": "2026-10-09T10:00:00.000Z" },
    "lastRun": { "at": "…", "status": "ok", "fromTurn": 3, "toTurn": 6 } } } }
```

- `lastTurn` is the item's cursor: the turn its last scheduled run covered up to. It moves when the run is **scheduled**, not when it succeeds; failed runs are not retried.
- `running` is set while a job for the item is pending or running. Another event skips the item until it is cleared, unless it is stale: the recorded pid is dead, or it is older than 30 minutes.
- If `turn` is ever lower than `lastTurn` (Pi `/tree` or a shorter branch), `lastTurn` is reset to `turn`.
- The lock is a file created with `O_EXCL` holding the owner's pid. It is taken over when that pid is dead or the file is older than 30 s; waiting for it gives up after 10 s.

`runs.jsonl` lines: `{ at, job, item, fromTurn, toTurn, status: "ok"|"error", model?, written?, warnings?, error?, ms }`.

## 7. CLI

| Command | Effect | Output |
|---|---|---|
| `agent-sidecar event [--json <event>] [--foreground]` | Validate the event, lock the session, schedule due items, write the job, start a detached `work` process (or run it in this process with `--foreground`). Returns quickly. | `{ job, turn, scheduled: [names], skipped: [{name, reason}] }` |
| `agent-sidecar run <item> --agent <a> --session <ref> [--model <m>] [--pane <id>] [--from-turn <n>] [--to-turn <n>] [--dry-run]` | Run one item now over a transcript, ignoring `everyTurns`. Does not move cursors or mark anything running. Range defaults: `context: session` → `0..last`; `delta` → `cursor..last`. `--model` stands in for the session model; without it, the model recorded in the transcript is used. `--dry-run` prints the prompt instead of calling the model. | `{ item, model, fromTurn, toTurn, text, output }` or `{ …, prompt }` |
| `agent-sidecar items` | Load and check all items. | One JSON line per valid item; errors on stderr |
| `agent-sidecar work <job-file>` | Internal: run a scheduled job. | JSON array of run records |

Exit codes: `0` success (an item that failed inside a job is still `0`; see `runs.jsonl`), `1` error (invalid event, unknown agent or item, I/O), `64` usage error. `items` exits `1` when any item file is invalid.

Environment: `AGENT_SIDECAR_HOME` (root), `AGENT_SIDECAR_PI_BIN` (Pi binary, default `pi`), `HERDR_BIN_PATH` (Herdr binary), `AGENT_SIDECAR_NODE` (Node used by the Pi extension, default `node`), `AGENT_SIDECAR_DISABLE=1` (extension does nothing), `AGENT_SIDECAR_CHILD=1` (set on the CLI's own `pi -p` calls; the extension does nothing there).

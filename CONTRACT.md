# agent-sidecar contract

This file is the authoritative definition of everything that crosses a boundary in agent-sidecar: the event an adapter sends, adapter and runner interfaces, item and config files, outputs, the storage tree and the CLI. Code that disagrees with it is a bug. Version: **event v1**.

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
| `model` | string or null | no | The session's current model, passed to the selected runner (Pi: `provider/id`). Last fallback for model choice. |
| `pane` | string or null | no | Herdr pane id when the agent runs inside Herdr (`$HERDR_PANE_ID`). Enables Herdr title updates. |
| `turn` | integer ≥ 0 or null | no | Number of user turns on the session's active branch, including the one just finished. When missing, the CLI counts the turns in the transcript. |

**Turn**: one user prompt and everything the agent did for it, until the agent is fully idle again. Model calls inside tool loops are not separate turns. A turn ends when the agent has settled (Pi: `agent_settled`). Aborted runs (Esc) are not reported.

**Idempotence**: reporting the same successfully completed `turn` twice schedules nothing the second time. If the first run failed, its `completedThrough` cursor is unchanged and a later event may retry the item.

## 2. Adapters

An adapter is one entry in `adapters/index.js`:

```js
{
  name: 'pi',
  readTranscript(transcriptRef) → { session, cwd, model, createdAt, createdAtError?, messages: [{ role, text, name? }] },
}
```

- `readTranscript` returns the session's **active branch** only, oldest first. `role` is `user`, `assistant`, `toolCall` or `toolResult`. A turn starts at each `user` message. `name` is the tool name for tool messages. Tool calls remain separate from assistant text so an item can filter them; hidden reasoning is left out.
- `createdAt` is the original session creation time as a normalized UTC ISO 8601 string, read from the agent's session header. `createdAtError` is a diagnostic when the header timestamp is missing or invalid; readers continue to provide the transcript so legacy paths can still run, but `{sessionMonth}` paths and automatic metadata then fail visibly instead of using the current time.
- `model` is the session's current model as far as the transcript shows it (Pi: the latest model switch or assistant reply on the branch), or null. `agent-sidecar run` uses it as the session model when `--model` is not given.
- The transcript reader and the adapter's in-agent half stay in the agent-specific boundary; model execution belongs to a runner.

### 2.1 Runners

A runner is one entry in `runners/index.js`:

```js
{
  name: 'pi',
  callModel({ model, effort, prompt, timeoutMs, env }) → string,
}
```

- `callModel` makes one non-interactive call and returns the reply text. It must not trigger sidecar event reporting. The v1 Pi runner maps `effort` to `--thinking <effort>`, uses `pi -p --no-session --no-tools --no-extensions ...`, and sets `AGENT_SIDECAR_CHILD=1`.
- The v1 Jcode runner invokes `jcode run --json` with `--tool-profile none`, parses the returned `text`, and maps known `provider/id` model names to Jcode's `--provider` plus `--model` options. Jcode's effort stays under its own `~/.jcode/config.toml`; the common `effort` value is intentionally ignored by this runner.
- A runner is independent from the agent adapter. A Pi session can use the Pi adapter to read its transcript and a different runner for side work.
- The transcript reader and runner call run synchronously inside a short-lived CLI process.

The in-agent half of an adapter (Pi: `adapters/pi/extension.js`) only builds events, starts `agent-sidecar event`, and, if the agent can set its own terminal title, applies `title.txt` (see §5).

## 3. Items

Items live in `<root>/items/`. Each `.md`, `.yaml`, `.yml` or `.json` file is one item; other files (scripts, notes) are ignored. Files are read in name order on every event, so edits take effect on the next turn with no reload.

### Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `[A-Za-z0-9._-]+` | file name without extension | Unique item name. Used in state and output paths. |
| `everyTurns` | integer ≥ 1 | required | Run when at least this many turns passed since the item's last run. |
| `runner` | string | none | Runner for this item (see §3.3). If absent, use the global runner, then `pi`. |
| `model` | string | none | Model for this item (see §3.5). |
| `effort` | string | none | Reasoning effort for this item (see §3.4). |
| `prompt` | string | — | A prompt for the model. Exactly one of `prompt` / `script`. |
| `script` | string | — | A shell command (`/bin/sh -c`), run in the items directory. Exactly one of `prompt` / `script`. |
| `context` | string or mapping | `delta` | Transcript scope and projection. A mapping can set `scope`, `turns`, `include`, `maxChars` and `files` (see §3.2). |
| `output` | `title` \| `none` \| `{ file: <path template>, mode?: "append" \| "replace" }` | `none` | Where the result goes (§5). File output defaults to `append`. |

Unknown keys are errors (to catch typos such as `every_turns`). An invalid file is skipped with a message in the session's `sidecar.log` and in `agent-sidecar items`; the other items still run.

### 3.1 Formats

Markdown: YAML frontmatter holds the fields; the body is the prompt. A body and a frontmatter `prompt` together are an error. A Markdown file with an empty body must set `script` or `prompt` in the frontmatter.

```markdown
---
everyTurns: 2
context:
  scope: recent
  turns: 4
  include: [user, assistant]
  maxChars: 12000
output: title
---
Write a title of at most 6 words for this session.

{{transcript}}
```

YAML / JSON: the same fields as a mapping. In YAML, write `output` as a block mapping (below) or quote the path (`output: { file: "out/{agent}.md" }`): unquoted `{…}` placeholders are YAML flow syntax and fail to parse.

```yaml
everyTurns: 3
runner: pi
effort: high
model: anthropic/claude-haiku-4-5
context:
  scope: delta
  include: [user, assistant, toolCall]
  files:
    - "out/{agent}/{sessionMonth}/{session}/summary.md"
  maxChars: 30000
output:
  file: out/{agent}/{sessionMonth}/{session}/summary.md
  mode: replace
prompt: |
  Maintain the complete current summary from the existing snapshot and this delta.
  Return the replacement snapshot only.
  {{transcript}}
```

### 3.2 Context and prompt placeholders

`context` may be a legacy string (`delta` or `session`) or a mapping:

| Key | Type | Meaning |
|---|---|---|
| `scope` | `delta` \| `session` \| `recent` | `delta` covers turns `fromTurn+1 … toTurn`; `session` covers the active branch; `recent` covers the latest `turns` user turns. |
| `turns` | integer ≥ 1 | Required for `recent`; not valid for other scopes. |
| `include` | list | Optional roles to include: `user`, `assistant`, `toolCall`, `toolResult`. Defaults to all roles. |
| `maxChars` | integer ≥ 1 | Per-item context budget. Defaults to global `maxTranscriptChars`. |
| `files` | list of path templates | Optional files to preload as `[file …]` blocks. Relative paths resolve from the storage root and support the same placeholders as outputs; missing files are skipped. |

Messages are selected by scope and role before rendering. When `files` are configured, file blocks are rendered first in listed order and reserve the budget; the transcript uses the remainder. A single oversized file may be truncated, and complete transcript message blocks are retained within the remaining budget where possible; only a single oversized message block is cut as a last resort. Tool results are additionally limited to `toolResultLines` lines each. The rendered context is available as `{{transcript}}` and is automatically appended inside `<transcript>…</transcript>` when the prompt does not place that placeholder.

Other placeholders are `{{agent}}`, `{{session}}`, `{{item}}`, `{{turn}}` (= `toTurn`), `{{fromTurn}}`, `{{toTurn}}` and `{{cwd}}` (the session's working directory if the transcript has one). Unknown placeholders are left as written.

### 3.3 Runner choice

1. the item's `runner`, else
2. the global `runner` in config, else
3. the default runner `pi`.

The runner is used for prompt items. Script items receive the selected runner name in their input but may invoke any command themselves.

### 3.4 Effort choice

1. the item's `effort`, else
2. the global `effort` in config, else
3. no explicit effort; the selected runner uses its own default.

The value is an opaque string at the core boundary because each runner may use different names. The recommended shared values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. A Pi model's legacy `provider/id:level` suffix remains supported when no explicit `effort` is set; an explicit `effort` takes precedence.

### 3.5 Model choice

1. the item's `model`, else
2. the global `model` in config, else
3. the event's `model` (the session's current model), else
4. the run fails with "no model" (prompt items only).

The selected runner interprets the model string. Script items get the chosen model in their input but do not have to use it.

### 3.6 Script input and result

The script receives one JSON object on stdin:

```json
{ "transcript": "…", "agent": "pi", "session": "…", "item": "count", "turn": 7, "fromTurn": 4, "toTurn": 7,
  "cwd": "/work/demo", "runner": "pi", "effort": "high", "model": "anthropic/…", "event": { … }, "root": "/Users/me/.agent-sidecar" }
```

Its stdout is the result, sent to the item's `output`. A non-zero exit or a timeout (`timeoutMs`) fails the run. The script runs with the CLI's environment.

## 4. Global config

Optional, in `<root>/config.yaml`, `config.yml` or `config.json` (only one may exist). Unknown keys are errors.

| Key | Default | Meaning |
|---|---|---|
| `runner` | `pi` | Global default runner for prompt items. |
| `effort` | none | Global reasoning effort for prompt items. |
| `model` | none | Global default model. |
| `timeoutMs` | `120000` | Limit per model call or script. |
| `maxTranscriptChars` | `60000` | Size cap of `{{transcript}}`. |
| `toolResultLines` | `20` | Lines kept per tool result. |
| `lifecycle.clearTitleOnNew` | `true` | On Pi `session_start` with reason `new`, clear the pane label and the sidecar-owned Herdr metadata title. |
| `lifecycle.clearTitleOnResume` | `true` | The same cleanup for reason `resume`. When enabled, Pi does not immediately restore the resumed session's saved terminal title. |

The lifecycle settings are global behavior, not items: they do not call a model or consume turns. The Pi adapter applies them synchronously at session start. `clearTitle*` only clears titles owned by this sidecar plus the pane label; it does not remove other Herdr metadata sources.

## 5. Outputs

| `output` | Effect |
|---|---|
| `none` | Result discarded (a script that writes its own files). |
| `title` | First non-empty line of the result, stripped of quotes and `#`, at most 80 characters. Written to `state/<agent>/<session>/title.txt`. If the event has a `pane`, also `herdr pane report-metadata <pane> --source agent-sidecar --title <title>` (`$HERDR_BIN_PATH` or `herdr`). An adapter that can set its own terminal title watches `title.txt` and applies it (Pi does). An empty title writes nothing. |
| `{ file: <template>, mode: "append" }` | Appends `## <ISO time> · <item> · <agent> <session> · turns <from+1>–<to>`, a blank line and the result. An empty result appends nothing (so a knowledge item can answer with nothing). |
| `{ file: <template>, mode: "replace" }` | Atomically replaces the file with the trimmed result and a trailing newline. An empty result leaves the existing file unchanged. Useful for current-state snapshots such as `summary.md`. |

Path template placeholders: `{agent}`, `{session}`, `{sessionMonth}` (UTC `YYYY-MM` from the original session creation time), `{item}`, and `{date}` (local `YYYY-MM-DD` at write time). Any other `{…}` is an error. `~/` expands to `$HOME`; relative paths are relative to the storage root. `{agent}` and `{session}` are made safe for one path segment. `{sessionMonth}` is unavailable when the session header has no valid creation time and produces an explicit error.

The sidecar also creates one automatic metadata file at `out/{agent}/{sessionMonth}/{session}/metadata.json` when a normal `work` or non-dry `run` first processes a session. Its minimum content is:

```json
{"sessionId":"0199a3f2-…","agent":"pi","createdAt":"2026-10-10T13:35:00.000Z"}
```

The file is fully written and synced to a same-directory temporary file, then published with an exclusive hard-link step; it is never rewritten by later events. A pre-existing file is accepted only when its required fields match the current session; malformed or mismatched metadata is an explicit error. This canonical metadata location is independent of custom item output paths.

### 5.1 Execution semantics

Scheduled item execution is **at-least-once**, not exactly-once. The output is written before the successful `completedThrough` checkpoint is committed, so a process crash in between can cause the same turn range to run again on a later event. `replace` output is generally safe for this retry because it rewrites the snapshot; `append` output can produce duplicate records and should be used only when that trade-off is acceptable. The v1 implementation intentionally has no transaction, deduplication or queue mechanism for this small crash window.

## 6. Storage

One tree for every agent. Root: `$AGENT_SIDECAR_HOME`, default `~/.agent-sidecar`.

```
<root>/
  config.yaml                      global config (optional)
  items/                           item definitions
  out/<agent>/<sessionMonth>/<session>/
    metadata.json                  stable session metadata (when createdAt is valid)
    summary.md, knowledge.md       example item outputs
  out/<agent>/<session>/…          legacy/custom output paths remain valid
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
{ "v": 1, "items": { "summary": { "lastTurn": 6, "scheduledThrough": 6, "completedThrough": 6,
    "running": { "job": "1791…-a1b2c3", "pid": 4242, "since": "2026-10-09T10:00:00.000Z" },
    "lastRun": { "at": "…", "status": "ok", "fromTurn": 3, "toTurn": 6 } } } }
```

- `scheduledThrough` is the furthest turn reserved by a job; it prevents duplicate scheduling while the job is live.
- `completedThrough` is the furthest turn processed successfully and is the permanent delta checkpoint. Failed runs leave it unchanged and can be retried by a later event.
- `lastTurn` mirrors `completedThrough` for compatibility with v1 state files. Old state containing only `lastTurn` is migrated as an already-completed cursor.
- `running` is set while a job for the item is pending or running. Another event skips the item until it is cleared, unless it is stale: the recorded pid is dead, or it is older than 30 minutes.
- If `turn` is ever lower than `completedThrough` (Pi `/tree` or a shorter branch), the completion cursor is reset to `turn`.
- The lock is a file created with `O_EXCL` holding the owner's pid. It is taken over when that pid is dead; malformed lock files may be taken over after 30 s, while a live owner's lock is never stolen solely because it is old. Waiting for it gives up after 10 s.

`runs.jsonl` lines: `{ at, job, item, fromTurn, toTurn, status: "ok"|"error", runner?, effort?, model?, written?, warnings?, error?, ms }`.

## 7. CLI

| Command | Effect | Output |
|---|---|---|
| `agent-sidecar event [--json <event>] [--foreground]` | Validate the event, lock the session, schedule due items, write the job, start a detached `work` process (or run it in this process with `--foreground`). Returns quickly. | `{ job, turn, scheduled: [names], skipped: [{name, reason}] }` |
| `agent-sidecar run <item> --agent <a> --session <ref> [--model <m>] [--pane <id>] [--from-turn <n>] [--to-turn <n>] [--dry-run]` | Run one item now over a transcript, ignoring `everyTurns`. Does not move cursors or mark anything running. Range defaults: `context: session` → `0..last`; `delta` → `cursor..last`. `--model` stands in for the session model; without it, the model recorded in the transcript is used. `--dry-run` prints the prompt instead of calling the model. | `{ item, runner, effort, model, fromTurn, toTurn, text, output }` or `{ …, prompt }` |
| `agent-sidecar items` | Load and check all items. | One JSON line per valid item; errors on stderr |
| `agent-sidecar work <job-file>` | Internal: run a scheduled job. | JSON array of run records |

Exit codes: `0` success (an item that failed inside a job is still `0`; see `runs.jsonl`), `1` error (invalid event, unknown agent or item, I/O), `64` usage error. `items` exits `1` when any item file is invalid.

Environment: `AGENT_SIDECAR_HOME` (root), `AGENT_SIDECAR_PI_BIN` (Pi binary, default `pi`), `AGENT_SIDECAR_JCODE_BIN` (Jcode binary, default `jcode`), `AGENT_SIDECAR_JCODE_PROVIDER_PROFILE` (optional Jcode named provider profile), `HERDR_BIN_PATH` (Herdr binary), `AGENT_SIDECAR_NODE` (Node used by the Pi extension, default `node`), `AGENT_SIDECAR_DISABLE=1` (extension does nothing), `AGENT_SIDECAR_CHILD=1` (set on the CLI's own `pi -p` calls; the extension does nothing there).

# agent-sidecar

Runs configurable side work alongside AI coding agent sessions: every few turns it can retitle the terminal or Herdr pane, maintain a summary of what was done, or collect knowledge candidates, usually on a cheaper model than the session's. What runs is defined by **items**: Markdown, YAML or JSON files in one directory.

```
Pi (extension) ──event──► agent-sidecar event ──detached──► agent-sidecar work ──► selected runner (default: pi -p) / script
       ▲                         │                                │
       └──── NATS feedback / idle prompt ◄── output + checkpoint ─┘
                     ~/.agent-sidecar/state/pi/<session>/   outputs: title.txt + Herdr pane title, files under out/
```

The core is agent-neutral; each agent connects through an adapter. **v1 ships the Pi adapter only.**

## Why agent-sidecar?

Some work should continue as an agent session progresses: maintaining titles, summarizing the session and its decisions, and extracting reusable knowledge.

This work is related to the main task, but it is not the main task itself. If the primary agent does it directly, it consumes context, adds tool calls, and burdens the workflow. If it is exposed only as a manually triggered skill, the primary agent must remember these auxiliary responsibilities at all times.

agent-sidecar moves this work outside the primary agent. It runs configured items periodically in the background as the session progresses, so the primary agent can stay focused on the task while the side work happens alongside it.

| Document | Contents |
|---|---|
| [CONTRACT.md](CONTRACT.md) | Authoritative: event, adapter interface, item format, config, outputs, storage, CLI |
| [docs/PRD.md](docs/PRD.md) | Requirements and scope |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, concurrency, how to add an agent |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Design decisions and known limitations |
| [docs/TESTING.md](docs/TESTING.md) | Test suites and how to run them |

## Requirements

- Node 20.12+ (on `PATH` as `node`, used by the Pi extension to start the CLI)
- Pi (`pi` on `PATH`, or `AGENT_SIDECAR_PI_BIN`), logged in to the providers your items use
- Optional: Herdr, for pane titles
- Optional: a local NATS server for feedback; NATS 2.15+ is required for idle-prompt scheduling

## Install (on the machine that runs Pi)

```sh
git clone https://github.com/limars874/agent-sidecar.git ~/src/agent-sidecar
cd ~/src/agent-sidecar && npm ci

# items and optional global config
mkdir -p ~/.agent-sidecar/items
cp examples/items/title.md examples/items/summary.yaml examples/items/knowledge.md examples/items/turn-log.json ~/.agent-sidecar/items/
cp examples/config.yaml ~/.agent-sidecar/config.yaml   # edit: set model to a cheap one
# optional: enable feedback for an explicitly chosen item
# cp examples/items/review.md ~/.agent-sidecar/items/

# Register the repository as a Pi package; the manifest points at the Pi adapter
pi install ~/src/agent-sidecar

# optional: put the CLI on PATH
npm link
```

Start Pi as usual. After each finished turn the extension reports an event; items that are due run in the background. To turn it off for one run: `AGENT_SIDECAR_DISABLE=1 pi`.

## Items

One file per item in `~/.agent-sidecar/items/`. Full reference: [CONTRACT.md §3](CONTRACT.md#3-items).

```markdown
---
everyTurns: 2          # run every 2 turns
context:
  scope: recent         # latest user turns; legacy `session` and `delta` strings remain valid
  turns: 4
  include: [user, assistant]
  maxChars: 12000
output: title            # terminal / Herdr pane title
---
Write a title of at most 6 words for the coding session below. Reply with the title only.

{{transcript}}
```

```yaml
# summary.yaml
everyTurns: 3
runner: pi                            # optional; else config runner, else pi
effort: high                          # optional; runner maps this to its own flag
model: anthropic/claude-haiku-4-5     # optional; else config model, else the session's model
context:
  scope: delta
  include: [user, assistant, toolCall]
  files:
    - "out/{agent}/{sessionMonth}/{session}/summary.md"
  maxChars: 30000
output:
  file: out/{agent}/{sessionMonth}/{session}/summary.md
  mode: replace                       # current snapshot; use append for an activity log
prompt: |
  Maintain the complete current session summary using the existing snapshot and this delta.
  Return the replacement snapshot only.
  {{transcript}}
```

```json
{ "everyTurns": 10, "script": "./my-script.sh", "output": { "file": "out/{agent}/{session}/turns.md" } }
```

To run a prompt item through Jcode while the observed session remains Pi:

```yaml
runner: jcode
model: openai-codex/gpt-5.6-luna
prompt: |
  Summarize the transcript below.
  {{transcript}}
```

Shipped examples (`examples/items/`): `title.md` (pane title), `summary.yaml` (current-state snapshot), `knowledge.md` (knowledge candidates with evidence and confidence; writes nothing when there are none), `review.md` (optional `feedback: true` advisory item), `turn-log.json` (an append-only script item).

Runner choice per item: item `runner` → config `runner` → `pi` (the default runner). The runner is independent from the agent adapter: the Pi adapter reads the session transcript, while the selected runner performs the side work.

Context can be a legacy `delta`/`session` string or a mapping with `scope`, `turns`, `include`, `maxChars` and optional `files`. Existing context files consume the budget first, then the newest transcript uses the remainder; a single oversized file may be truncated, but a long delta cannot make the prior snapshot disappear. Path templates also support `{sessionMonth}` (UTC `YYYY-MM` from the original session creation time). Use `output.mode: replace` for a current-state snapshot such as `summary.md`; the default file mode remains `append` for activity logs and knowledge candidates.

Scheduled work is at-least-once: a crash after output is written but before the completion checkpoint can repeat a range. `replace` snapshots usually tolerate this; `append` outputs may contain duplicate records.

Effort choice per item: item `effort` → config `effort` → the runner's default. For Pi, `effort` is passed as `--thinking`; the old `model: provider/id:level` form remains supported when no explicit effort is set. Jcode uses its own `~/.jcode/config.toml` effort setting.

Model choice per item: item `model` → config `model` → the session's current model.

## Feedback to the originating Pi session

An item can opt in with `feedback: true`. After a successful non-empty result, agent-sidecar publishes a short advisory message through NATS to the exact Pi process that emitted the event; the Pi extension validates the instance and current session before queueing it with `sendMessage()`. A successful publish is not proof that the model received the message. Feedback does not replace file/title output and broker failures only produce bounded warnings; they do not fail the item or roll back its checkpoint.

Configure the broker globally; do not put the URL in every item:

```yaml
feedback:
  natsUrl: nats://127.0.0.1:4222
```

The default is the localhost URL above. For an authenticated local broker, use a credentialed URL or another supported NATS connection form in the untracked config file. Keep the broker bound to localhost unless you have deliberately secured remote access. The extension connects only when at least one loaded item opts in, starts after `session_start`, and closes on `session_shutdown`; the sidecar's own `pi -p` model children never subscribe or emit feedback.

## Idle prompt

Idle prompt is an opt-in mode that sends the configured prompt to the originating Pi agent after a period of inactivity. It uses NATS JetStream's native delayed message scheduling on a NATS 2.15+ server; it does not start a sidecar daemon, poll, inject terminal keys or silently reuse Feedback V1 semantics.

```yaml
idle:
  enabled: true
  after: 60m
  prompt: Reply with IDLE_OK.
```

Each normal work completion cancels the previous pending schedule and creates one replacement on a plan-specific schedule subject. When the schedule fires, the Pi extension validates the session, work turn and progress id, then sends the configured text as an `agent-sidecar-idle-prompt` custom message with `deliverAs: steer` and `triggerTurn: true`; this intentionally wakes the original idle Pi agent. The sidecar does not inspect the prompt or assign it a document-writing meaning.

The schedule is one-shot and stateful per session: a new work batch re-arms it, one batch triggers at most one prompt, and trigger completion is tracked separately from any work the agent performs. If cancellation or scheduling has an unknown result, the plan stays pending and retries the same plan id; a later work batch supersedes it without reusing the old schedule subject. JetStream or delivery failures are explicit warnings; there is no polling or fallback trigger. Full boundary details are in [CONTRACT.md §5.3](CONTRACT.md#53-idle-prompt).

## Lifecycle title cleanup

The Pi adapter treats title cleanup as global lifecycle behavior rather than an item. It clears the pane label and the sidecar-owned Herdr metadata title on session changes by default:

```yaml
lifecycle:
  clearTitleOnNew: true
  clearTitleOnResume: true
```

Set either value to `false` to preserve the corresponding title. Full configuration is documented in [CONTRACT.md §4](CONTRACT.md#4-global-config).

## Commands

```sh
agent-sidecar items                                        # check item files
agent-sidecar run summary --agent pi --session ~/.pi/agent/sessions/<dir>/<file>.jsonl --dry-run
agent-sidecar run summary --agent pi --session <file>.jsonl --from-turn 0   # run it for real, e.g. over a past session
echo '{"v":1,"agent":"pi","session":"…","transcriptRef":"….jsonl","turn":4}' | agent-sidecar event
```

`run` ignores `everyTurns` and leaves the item's cursor alone, so it is safe for testing an item or backfilling old sessions. Without `npm link`, use `node bin/agent-sidecar.js …`.

## Where things go

```
~/.agent-sidecar/
  items/  config.yaml
  out/pi/<sessionMonth>/<session>/
      metadata.json, summary.md, knowledge.md         (month-based example outputs)
  out/pi/<session>/…                                 (legacy/custom outputs remain valid)
  state/pi/<session>/title.txt, runs.jsonl, sidecar.log, state.json

NATS JetStream (when idle prompt is enabled):
  AGENT_SIDECAR_HANDOFF / schedule, target and control subjects
  (the stream name and subject prefix are retained for safe migration)
```

Metadata is created on the first valid session event, independently of item trigger intervals; `summary.md` and `knowledge.md` still wait for their configured turns. When an item does not seem to run, check `agent-sidecar items`, then `state/pi/<session>/sidecar.log` and `runs.jsonl`. Switching an item to `{sessionMonth}` does not migrate or read its old output path; old files remain in place for manual migration if needed.

## Tests

```sh
npm test
```

No real Pi, Herdr or network is needed: tests use fake `pi` and `herdr` binaries. See [docs/TESTING.md](docs/TESTING.md), including the manual live check with a real Pi.

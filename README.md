# agent-sidecar

Runs configurable side work alongside AI coding agent sessions: every few turns it can retitle the terminal or Herdr pane, append a summary of what was done, or collect knowledge candidates, usually on a cheaper model than the session's. What runs is defined by **items**: Markdown, YAML or JSON files in one directory.

```
Pi (extension) ──event──► agent-sidecar event ──detached──► agent-sidecar work ──► pi -p (cheap model) / script
                                 │                                │
                     ~/.agent-sidecar/state/pi/<session>/   outputs: title.txt + Herdr pane title, files under out/
```

The core is agent-neutral; each agent connects through an adapter. **v1 ships the Pi adapter only.**

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

## Install (on the machine that runs Pi)

```sh
git clone https://github.com/limars874/agent-sidecar.git ~/src/agent-sidecar
cd ~/src/agent-sidecar && npm ci

# items and optional global config
mkdir -p ~/.agent-sidecar/items
cp examples/items/* ~/.agent-sidecar/items/
cp examples/config.yaml ~/.agent-sidecar/config.yaml   # edit: set model to a cheap one

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
context: session       # the whole conversation (default: delta = turns since the last run)
output: title          # terminal / Herdr pane title
---
Write a title of at most 6 words for the coding session below. Reply with the title only.

{{transcript}}
```

```yaml
# summary.yaml
everyTurns: 3
model: anthropic/claude-haiku-4-5     # optional; else config model, else the session's model
output:
  file: out/{agent}/{session}/summary.md
prompt: |
  Summarize what was done in turns {{fromTurn}}+1 to {{toTurn}} as bullets.
  {{transcript}}
```

```json
{ "everyTurns": 10, "script": "./my-script.sh", "output": { "file": "out/{agent}/{session}/turns.md" } }
```

Shipped examples (`examples/items/`): `title.md` (pane title), `summary.yaml` (work log), `knowledge.md` (knowledge candidates with evidence and confidence; writes nothing when there are none), `turn-log.json` (a script item).

Model choice per item: item `model` → config `model` → the session's current model.

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
  out/pi/<session>/summary.md, knowledge.md          (example items' outputs)
  state/pi/<session>/title.txt, runs.jsonl, sidecar.log, state.json
```

When an item does not seem to run, check `agent-sidecar items`, then `state/pi/<session>/sidecar.log` and `runs.jsonl`.

## Tests

```sh
npm test
```

No real Pi, Herdr or network is needed: tests use fake `pi` and `herdr` binaries. See [docs/TESTING.md](docs/TESTING.md), including the manual live check with a real Pi.

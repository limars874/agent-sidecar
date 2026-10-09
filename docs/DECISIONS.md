# Decisions and known limitations

## Decisions

**D1 — CLI host first; the Pi extension is thin.** All item work runs in the `agent-sidecar` CLI, also for Pi, which could have done it in-process. One code path then serves every future agent, and it is proven from day one by the agent that uses it. Cost: model calls go through `pi -p` (a process start per call) instead of Pi's in-process model registry.

**D2 — A turn is one finished user prompt run.** Pi's `agent_settled` (not `turn_end`, which fires per model call inside tool loops). "Every N turns" then means N user prompts, independent of how many tools the agent used. Aborted runs are not counted as events, but a later event counts their user message.

**D3 — The turn number is derived from the transcript, not counted by the sidecar.** `turn` = user messages on the active branch. Duplicate events are harmless, a missed event is caught up by the next one, and a fork or `/tree` jump simply yields a different number.

**D4 — Cursors move when a run is scheduled.** This prevents double scheduling between quick events. Consequence: a failed run is not retried; its turns are covered again only by `context: session` items or a manual `run`.

**D5 — Two detached processes (`event` → `work`).** `event` is fast and safe to call from blocking hooks; `work` does the slow part. No daemon is needed: per-session state files and a lock replace in-memory state.

**D6 — Lock file with `O_EXCL` and pid.** Plain stdlib, works on macOS and Linux, recovers from dead holders. Only short read-modify-write sections take the lock; model calls never do.

**D7 — One storage tree for all agents** (`~/.agent-sidecar`), namespaced `state/<agent>/<session>`. Items are shared by all agents.

**D8 — Title output goes through a file plus Herdr.** A detached process cannot set the agent's terminal title, so `title` writes `title.txt`, which the Pi extension applies with `ctx.ui.setTitle`; Herdr pane titles are set directly from the CLI with `herdr pane report-metadata --source agent-sidecar`.

**D9 — `pi -p` children are bare and guarded.** `--no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-mcp`, prompt on stdin, cwd = temp dir, and `AGENT_SIDECAR_CHILD=1` so even an explicitly loaded sidecar extension stays inactive. No recursion, no session files from side work, no project files pulled into the prompt.

**D10 — Items: strict validation, all three formats normalized to one shape.** Unknown keys are errors, a bad file is skipped and reported, others keep working. Markdown suits long prompts (body), YAML suits settings-heavy or script items, JSON suits generated items.

**D11 — Delta context by default; recent part kept when too long.** Summaries and knowledge extraction want "what is new"; titles use `context: session`. When the text exceeds `maxTranscriptChars`, the oldest part is cut because the newest is what triggered the run.

**D12 — Knowledge output is candidates, not knowledge.** Items append to files; nothing writes into a curated knowledge base. Review and promotion stay with a person.

**D13 — Plain ESM JavaScript, one dependency (`yaml`).** Matches the user's other tools (tug), runs without a build step, and Pi loads `.js` extensions directly. Node has no YAML parser, so `yaml` is the only dependency.

## Known limitations

- **Only Pi.** No other adapter exists yet (by design for v1).
- **No run at session end.** Up to `everyTurns − 1` final turns of a session are never processed automatically. Use `agent-sidecar run` to catch up.
- **Active branch = last entry in the file.** Same rule as Pi's own loader. If a user moves around the tree with `/tree` without adding a message, the CLI still reads the branch of the last written entry.
- **Transcript coverage.** Only user, assistant (text and tool calls) and tool result messages are read. Pi's other message kinds (user `!bash` executions, extension messages, compaction and branch summaries) are not part of the transcript.
- **Herdr title semantics unverified live.** The call follows `herdr pane report-metadata --help` (Herdr 0.9.1). Whether Herdr shows a display title from the `agent-sidecar` source alongside its own Pi integration has not been checked in a live session. Failures are logged as warnings.
- **Title only for Pi's own terminal and Herdr.** Outside Herdr, a future hook-only adapter cannot set the terminal title.
- **Prompts leave the machine.** `{{transcript}}` is sent to whichever provider the chosen model belongs to.
- **Cost control is by configuration only**: `everyTurns`, model choice and `maxTranscriptChars`. There is no budget limit.
- **Process cost.** Each finished turn starts one short Node process; each due item one `pi -p` process.
- **No retries**, and a run whose worker is killed is noticed only by pid/age (30 min) on a later event.
- **Script items are trusted code.** They run with the user's environment and permissions, like any file the user places in `items/`.
- **`AGENT_SIDECAR_NODE`.** Inside the Pi binary, `process.execPath` is Pi, not Node, so the extension starts the CLI with `node` from `PATH` (or `AGENT_SIDECAR_NODE`).

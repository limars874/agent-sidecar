# Decisions and known limitations

## Decisions

**D1 — CLI host first; the Pi extension is thin.** All item work runs in the `agent-sidecar` CLI, also for Pi, which could have done it in-process. One code path then serves every future agent, and it is proven from day one by the agent that uses it. Cost: model calls go through `pi -p` (a process start per call) instead of Pi's in-process model registry.

**D2 — A turn is one finished user prompt run.** Pi's `agent_settled` (not `turn_end`, which fires per model call inside tool loops). "Every N turns" then means N user prompts, independent of how many tools the agent used. Aborted runs are not counted as events, but a later event counts their user message.

**D3 — The turn number is derived from the transcript, not counted by the sidecar.** `turn` = user messages on the active branch. Duplicate events are harmless, a missed event is caught up by the next one, and a fork or `/tree` jump simply yields a different number.

**D4 — Separate scheduled and completed cursors.** `scheduledThrough` prevents duplicate scheduling while a job is pending or running; `completedThrough` (mirrored by legacy `lastTurn`) advances only after a successful item run. A failed run remains retryable on a later event without allowing concurrent duplicates.

**D5 — Two detached processes (`event` → `work`).** `event` is fast and safe to call from blocking hooks; `work` does the slow part. No daemon is needed: per-session state files and a lock replace in-memory state.

**D6 — Lock file with `O_EXCL` and pid.** Plain stdlib, works on macOS and Linux, recovers from dead holders. Only short read-modify-write sections take the lock; model calls never do.

**D7 — One storage tree for all agents** (`~/.agent-sidecar`), namespaced `state/<agent>/<session>`. Items are shared by all agents.

**D8 — Title output goes through a file plus Herdr.** A detached process cannot set the agent's terminal title, so `title` writes `title.txt`, which the Pi extension applies with `ctx.ui.setTitle`; Herdr pane titles are set directly from the CLI with `herdr pane report-metadata --source agent-sidecar`.

**D9 — `pi -p` children are bare and guarded.** `--no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files` (not `--no-mcp`: the Pi tested live rejects it, and an unknown flag fails the call), prompt on stdin, cwd = temp dir, and `AGENT_SIDECAR_CHILD=1` so even an explicitly loaded sidecar extension stays inactive. No recursion, no session files from side work, no project files pulled into the prompt.

**D10 — Items: strict validation, all three formats normalized to one shape.** Unknown keys are errors, a bad file is skipped and reported, others keep working. Markdown suits long prompts (body), YAML suits settings-heavy or script items, JSON suits generated items.

**D11 — Context is a per-item projection, not one global transcript string.** Legacy `delta` and `session` remain valid, while a mapping can select `scope`, recent turns, message roles, files and a per-item character budget. Existing context files consume the budget first, then the newest transcript is rendered into the remainder, so a long delta cannot make the prior snapshot disappear.

**D12 — Knowledge output is candidates, not knowledge.** Items append to files; nothing writes into a curated knowledge base. Review and promotion stay with a person.

**D13 — Plain ESM JavaScript, one dependency (`yaml`).** Matches the user's other tools (tug), runs without a build step, and Pi loads `.js` extensions directly. Node has no YAML parser, so `yaml` is the only dependency.

**D14 — Adapters and runners are separate.** An adapter reads the observed agent's session and reports its events; a runner performs one-shot model work. This lets a Pi session use a future Claude or Codex runner without replacing its Pi transcript adapter. The default runner remains `pi` for backward compatibility.

**D15 — Use `effort` as the normalized reasoning control.** `effort` is an opaque cross-runner value; each runner maps it to its own CLI terminology (`--thinking` for Pi). It is separate from `model`, while Pi's `model: provider/id:level` syntax remains a compatibility fallback when no explicit effort is configured.

**D16 — Jcode uses its own effort configuration for v1.** `jcode run` exposes no per-call effort flag in the installed `v0.93.0` CLI, so the Jcode runner does not synthesize or mutate Jcode configuration. It uses the existing `~/.jcode/config.toml` provider/model settings and only adapts the invocation shape and model name.

**D17 — File output explicitly supports append and replace.** Append remains the backward-compatible default for activity logs and knowledge candidates. Replace atomically writes a complete current-state snapshot, so summary items can consume the previous snapshot plus new delta without accumulating headers or historical prose.

**D18 — Keep context files as a convenience, not a capability boundary.** `context.files` preloads existing files into the rendered context and skips a missing file on the first run. It does not restrict a runner or script from reading or writing other paths; capability restrictions require a separate security design.

**D19 — Scheduled execution is at-least-once.** Output is written before the successful completion checkpoint, so a crash in that small window can repeat a turn range. `replace` snapshots normally tolerate the repeat; `append` logs may duplicate records. Do not add transactions or general deduplication until real usage justifies their complexity.

**D20 — Session output grouping uses the original UTC creation month.** `{sessionMonth}` comes from the agent session header, not sidecar processing time, and remains stable across retries and month boundaries. The canonical metadata file is created at the first valid `event`, with `work` and manual `run` as idempotent fallbacks. It is fully prepared in a temporary file and published with exclusive creation; existing metadata is validated and never overwritten. Legacy/custom paths remain compatible and are not auto-migrated.

## Known limitations

- **Only Pi adapter.** No Claude Code, Codex or other agent adapter exists yet. Runners currently include `pi` and `jcode`.
- **Jcode effort is configuration-scoped.** The installed Jcode CLI has no per-call effort flag, so sidecar `effort` does not override `~/.jcode/config.toml` for Jcode runs.
- **No run at session end.** Up to `everyTurns − 1` final turns of a session are never processed automatically. Use `agent-sidecar run` to catch up.
- **Active branch = last entry in the file.** Same rule as Pi's own loader. If a user moves around the tree with `/tree` without adding a message, the CLI still reads the branch of the last written entry.
- **Creation time is required only for new month-based paths.** A missing or invalid session header timestamp is logged and leaves legacy paths usable, but prevents `{sessionMonth}` expansion and canonical metadata creation.
- **Transcript coverage.** Only user, assistant text, tool calls and tool results are read. Pi's other message kinds (user `!bash` executions, extension messages, compaction and branch summaries) are not part of the transcript.
- **Herdr title semantics unverified live.** The call follows `herdr pane report-metadata --help` (Herdr 0.9.1). Whether Herdr shows a display title from the `agent-sidecar` source alongside its own Pi integration has not been checked in a live session. Failures are logged as warnings.
- **Title only for Pi's own terminal and Herdr.** Outside Herdr, a future hook-only adapter cannot set the terminal title.
- **Prompts leave the machine.** `{{transcript}}` is sent to whichever provider the chosen model belongs to.
- **Cost control is by configuration only**: `everyTurns`, model choice, per-item `context.maxChars` and global `maxTranscriptChars`. There is no token or spend budget limit.
- **No automatic output migration.** Switching an item to `{sessionMonth}` leaves its old output in place and starts a new path; manual migration is intentionally outside v1.
- **Process cost.** Each finished turn starts one short Node process; each due prompt item one selected runner process (the v1 default is `pi -p`).
- **Retries have no backoff or attempt cap.** A failed item remains due and retries on a later event; a worker killed mid-run is noticed only by pid/age (30 min). Duplicate side effects are still the responsibility of the item's output/runner design.
- **Script items are trusted code.** They run with the user's environment and permissions, like any file the user places in `items/`.
- **Pi runner CLI flags.** The `pi -p` flags were taken from Pi's source on GitHub; a Pi older than those flags fails every model call with `Unknown option` (visible in `runs.jsonl`). MCP servers configured for Pi still start in the child.
- **`AGENT_SIDECAR_NODE`.** Inside the Pi binary, `process.execPath` is Pi, not Node, so the extension starts the CLI with `node` from `PATH` (or `AGENT_SIDECAR_NODE`).

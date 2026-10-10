# agent-sidecar — product requirements

## Problem

Long AI coding agent sessions lose their shape: terminal and Herdr pane titles say nothing about the task, nobody writes down what was done, and facts learned along the way stay buried in transcripts. The main agent should not spend its own (expensive) context and attention on this bookkeeping.

## Goal

A companion that follows a running agent session, observes the conversation, and every few turns does configured side work, normally on a cheaper model:

1. update the terminal title and the Herdr pane title from the conversation;
2. summarize and record what has been done;
3. extract possible knowledge points as candidates for later review.

New kinds of side work must be addable without code changes, by dropping definition files into one directory, much like skills.

## Users

One developer running agent sessions (initially Pi) in terminals or Herdr panes, who wants titles, work logs and knowledge candidates without asking for them.

## Requirements

| # | Requirement | Where |
|---|---|---|
| R1 | Follow the current agent process and observe its conversation. | Pi extension reports each finished turn; the CLI reads the session file. |
| R2 | Use a cheaper model for side work. | Per-item and global `model`; calls go through the selected runner (v1 default: `pi -p`). |
| R3 | Update the terminal / Herdr pane title from conversation changes. | `output: title` → `title.txt` (applied by the extension) + `herdr pane report-metadata`. |
| R4 | Maintain a compact current-state summary of what has been done. | Item with `context.files` + `output.mode: replace` (example `summary.yaml`). |
| R5 | Extract possible knowledge points into a chosen directory. | Item with `output: { file }` (example `knowledge.md`), path template chooses the directory. |
| R6 | Extensible: items as Markdown, YAML or JSON files in one directory; several items, each doing its own configured work. | `~/.agent-sidecar/items/`, CONTRACT.md §3. |
| R7 | Each item triggers a prompt or a script every N turns. | `everyTurns`, `prompt` / `script`. |
| R8 | Model: item model, else global model, else the session's current model. | CONTRACT.md §3.5. |
| R9 | Agent-neutral architecture with a CLI host from the start; Pi is one adapter and one default runner. | `core/` + `host/` + `adapters/pi/` + `runners/pi.js`. |
| R10 | Core keeps no state between events; file-based state, cursors, locking, detached work. | `state/<agent>/<session>/`, CONTRACT.md §6. |
| R11 | One event contract (`agent, session, transcriptRef, model, pane, turn`). | CONTRACT.md §1. |
| R12 | Manual runner over a session file. | `agent-sidecar run <item> --agent pi --session <file.jsonl>`. |
| R13 | One shared storage tree, namespaced by agent and session. | `~/.agent-sidecar/`. |
| R14 | Optionally control reasoning effort independently from the model name. | Per-item and global `effort`; each runner maps it to its own CLI parameter when supported. |
| R15 | Use Jcode as an alternative one-shot runner while observing a Pi session. | `runner: jcode` invokes `jcode run --json`; Pi remains the transcript adapter. |
| R16 | Let each item choose the transcript scope, roles, files and context budget. | Legacy `delta`/`session` plus `context.scope`, `turns`, `include`, `files` and `maxChars`. |
| R17 | Distinguish scheduled work from successfully completed work. | `scheduledThrough` prevents duplicate scheduling; `completedThrough` advances only after success. |
| R18 | Support both activity logs and current-state files. | File output defaults to `append`; `mode: replace` atomically replaces a snapshot. |
| R19 | Make scheduled execution semantics explicit. | At-least-once delivery: replace snapshots are usually repeat-safe; append logs may duplicate after a crash window. |
| R20 | Group session outputs by the original creation month. | `{sessionMonth}` is derived from the session header timestamp in UTC and remains stable across retries and later writes. |
| R21 | Record stable session metadata once. | Canonical `out/{agent}/{sessionMonth}/{session}/metadata.json`, created on the first valid session event, exclusively and never overwritten. |

## Non-goals (v1)

- Adapters for Claude Code, Codex, Grok CLI or others (the boundary is ready; none is implemented).
- Writing directly into a knowledge base: knowledge output is candidates in files, reviewed by a person.
- Running items at session end, on compaction, or on a timer; only every N turns.
- A per-project items directory; there is one global directory.
- Exactly-once delivery, transactional output, automatic migration of old output paths, retry backoff, attempt limits, a daemon, or a UI beyond titles.

## Success criteria

- With the example items installed, a Pi session in Herdr gets a pane title after 2 turns, `summary.md` is replaced with the current snapshot every 3 turns, and `knowledge.md` gets candidates (or nothing) every 5 turns.
- The main Pi session never waits for side work: the extension only starts a process.
- An invalid item file never stops other items, and its error is visible in `agent-sidecar items` and `sidecar.log`.
- All behaviour above is covered by `npm test` without network access.

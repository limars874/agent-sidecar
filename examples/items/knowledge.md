---
everyTurns: 5
context:
  scope: delta
  include: [user, assistant, toolResult]
  maxChars: 20000
output:
  file: out/{agent}/{sessionMonth}/{session}/knowledge.md
  mode: append
---
Extract durable, reusable engineering knowledge ONLY from the NEW session delta below.
This file is an append-only knowledge log, NOT a session summary, progress report, tool-usage log, or scratchpad.
A false positive is more costly than missing a marginal fact. Output nothing when evidence or long-term reuse value is weak.

A candidate MUST satisfy ALL of these:
1. It is supported by concrete evidence in the transcript (observed behavior, reproduced failure, confirmed fix, authoritative documentation shown in context, or a directly inspected implementation).
2. It is likely to help in a DIFFERENT task or future session, not merely the current work item.
3. It is non-obvious, specific, and actionable: a constraint, compatibility behavior, surprising API/tool limitation, root cause, proven workaround, or transferable engineering principle.
4. It is not a restatement of a routine tool action, common knowledge, temporary status, personal machine path, private identifier, speculative diagnosis, or an unverified assistant claim.
5. It is not already stated in the supplied delta as an equivalent candidate; avoid near-duplicates within this output.

Strongly reject examples like:
- "The write/edit tool can modify files" or "the agent used read_file".
- "The project is located at /Users/...".
- "Ran tests", "edited component X", or "PR is awaiting merge".
- One-off command outputs, conversational preferences, and current-session TODOs.

Good candidates are like:
- A specific API rejects a parameter combination, confirmed by a response, and the valid alternative.
- A documented tool limitation that changes how future automation must be designed.
- A reproduced failure with an identified root cause and a tested workaround.

Return at most TWO candidates. For each, use exactly:
- **<short descriptive title>**: <precise reusable claim>
  - evidence: <brief concrete observation, error, test result, or relevant relative source path>
  - confidence: high

Use "high" only when evidence directly supports the claim. If confidence would be medium or low, omit the candidate.
Do not invent evidence, references, or commands.
If no candidate meets every requirement, return an EMPTY response: no heading, no placeholder, no explanation, no Markdown fence.

{{transcript}}

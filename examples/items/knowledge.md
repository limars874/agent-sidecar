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
From the new session delta below, extract only reusable facts about tools, environments, APIs, or pitfalls that were verified in the transcript.

Return at most 3 candidates. For each candidate use:
- **<title>**: <one-sentence claim>
  - evidence: <one concise command, file path, or output>
  - confidence: <high | medium>

Skip plans, guesses, chatter, task-specific details, and facts that are already obvious from the candidate itself. If there is nothing worth keeping, reply with nothing at all.

{{transcript}}

---
everyTurns: 5
feedback: true
context:
  scope: delta
  include: [user, assistant, toolResult]
  maxChars: 12000
output: none
---
Review the session delta below for one actionable, verified point that the primary agent should see now.

Return nothing unless there is a concrete issue, decision, or important next step supported by the transcript. Do not repeat the title or summary, describe tool mechanics, or report that a command ran. Return at most one item using:
- type: issue | decision | next
- message: <one concise sentence>
- evidence: <one concise supporting fact>

{{transcript}}

// Agent-neutral transcript (CONTRACT.md "Adapters"): adapters turn their own
// session format into { session, cwd, messages: [{ role, text, name? }] } with
// role 'user' | 'assistant' | 'tool'. A turn starts at each user message.

export function countTurns(messages) {
  return messages.filter((m) => m.role === 'user').length;
}

// Messages of turns fromTurn+1 .. toTurn.
export function sliceTurns(messages, fromTurn, toTurn) {
  const out = [];
  let turn = 0;
  for (const m of messages) {
    if (m.role === 'user') turn += 1;
    if (turn > fromTurn && turn <= toTurn) out.push(m);
  }
  return out;
}

export function renderTranscript(messages, { maxChars, toolResultLines }) {
  const blocks = messages.map((m) => {
    if (m.role === 'tool') return `[tool${m.name ? ` ${m.name}` : ''}]\n${truncateLines(m.text, toolResultLines)}`;
    return `[${m.role}]\n${m.text}`;
  });
  const text = blocks.join('\n\n');
  if (text.length <= maxChars) return text;
  // Keep the most recent part: it is what changed since the last run.
  const marker = '[… earlier transcript truncated]\n\n';
  return marker + text.slice(text.length - (maxChars - marker.length));
}

function truncateLines(text, max) {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), `… [${lines.length - max} more lines]`].join('\n');
}

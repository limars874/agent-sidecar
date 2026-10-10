// Agent-neutral transcript (CONTRACT.md "Adapters"):
// adapters turn their own session format into structured messages. A turn starts
// at each user message; tool calls and tool results remain independently filterable.

export const TRANSCRIPT_ROLES = Object.freeze(['user', 'assistant', 'toolCall', 'toolResult']);

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

export function selectMessages(messages, include = null) {
  if (!include) return messages;
  const allowed = new Set(include);
  return messages.filter((message) => allowed.has(normalizeRole(message.role)));
}

export function formatTranscriptBlocks(messages, { toolResultLines = 20, include = null } = {}) {
  return selectMessages(messages, include).map((message) => formatMessage(message, toolResultLines));
}

export function renderTranscript(messages, { maxChars, toolResultLines, include } = {}) {
  return renderBlocks(formatTranscriptBlocks(messages, { toolResultLines, include }), maxChars);
}

// Render whole message blocks first, then keep the newest complete blocks within
// the budget. Only a single oversized block is cut as a last resort.
export function renderBlocks(blocks, maxChars = Infinity) {
  const textBlocks = blocks.filter((block) => block !== '');
  const text = textBlocks.join('\n\n');
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;

  const marker = '[… earlier context truncated]\n\n';
  if (maxChars <= marker.length) return marker.slice(0, maxChars);

  let remaining = maxChars - marker.length;
  const kept = [];
  for (let index = textBlocks.length - 1; index >= 0; index -= 1) {
    const block = textBlocks[index];
    const separatorLength = kept.length > 0 ? 2 : 0;
    if (block.length + separatorLength <= remaining) {
      kept.unshift(block);
      remaining -= block.length + separatorLength;
      continue;
    }
    if (kept.length === 0 && remaining > 0) kept.unshift(block.slice(0, remaining));
    break;
  }
  return `${marker}${kept.join('\n\n')}`;
}

function normalizeRole(role) {
  return role === 'tool' ? 'toolResult' : role;
}

function formatMessage(message, toolResultLines) {
  const role = normalizeRole(message.role);
  if (role === 'toolResult') {
    return `[tool${message.name ? ` ${message.name}` : ''}]\n${truncateLines(message.text ?? '', toolResultLines)}`;
  }
  if (role === 'toolCall') return `[toolCall${message.name ? ` ${message.name}` : ''}]\n${message.text ?? ''}`;
  return `[${role}]\n${message.text ?? ''}`;
}

function truncateLines(text, max) {
  const lines = text.split('\n');
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), `… [${lines.length - max} more lines]`].join('\n');
}

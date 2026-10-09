// Reads a Pi session file (JSONL, format v3) into the agent-neutral transcript.
// The file is a tree: each entry has id/parentId. Like Pi's own loader, the
// active branch ends at the last entry in the file and follows parentId to
// the root; abandoned branches are left out.
import fs from 'node:fs';

const TOOL_ARGS_MAX = 300;

export function readPiSession(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let header = null;
  const byId = new Map();
  let leafId = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line Pi is still writing, or a damaged one
    }
    if (entry.type === 'session') {
      header ??= entry;
      continue;
    }
    if (typeof entry.id !== 'string') continue;
    byId.set(entry.id, entry);
    leafId = entry.id;
  }
  if (!header) throw new Error(`${file}: not a Pi session (no session header)`);

  const branch = [];
  const seen = new Set();
  for (let id = leafId; id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) {
    seen.add(id);
    branch.push(byId.get(id));
  }
  branch.reverse();

  return {
    session: header.id,
    cwd: header.cwd ?? null,
    model: lastModel(branch),
    messages: branch.filter((e) => e.type === 'message').map((e) => toMessage(e.message)).filter(Boolean),
  };
}

// The session's current model: the latest model switch or assistant reply on the branch.
function lastModel(branch) {
  let model = null;
  for (const e of branch) {
    if (e.type === 'model_change' && e.provider && e.modelId) model = `${e.provider}/${e.modelId}`;
    const m = e.type === 'message' ? e.message : null;
    if (m?.role === 'assistant' && m.provider && m.model) model = `${m.provider}/${m.model}`;
  }
  return model;
}

function toMessage(m) {
  if (!m) return null;
  if (m.role === 'user') {
    const text = contentText(m.content);
    return text ? { role: 'user', text } : { role: 'user', text: '[empty message]' };
  }
  if (m.role === 'assistant') {
    const parts = [];
    for (const c of m.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) parts.push(c.text.trim());
      if (c.type === 'toolCall') parts.push(`→ ${c.name} ${clip(JSON.stringify(c.arguments ?? {}), TOOL_ARGS_MAX)}`);
    }
    return parts.length ? { role: 'assistant', text: parts.join('\n') } : null;
  }
  if (m.role === 'toolResult') {
    return { role: 'tool', name: m.toolName, text: contentText(m.content) };
  }
  return null; // other roles (e.g. Pi's own bash/custom messages) are not part of v1
}

function contentText(content) {
  if (typeof content === 'string') return content.trim();
  return (content ?? [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function clip(s, max) {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

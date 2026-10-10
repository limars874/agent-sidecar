// Reads a Pi session file (JSONL, format v3) into the agent-neutral transcript.
// The file is a tree: each entry has id/parentId. Like Pi's own loader, the
// active branch ends at the last entry in the file and follows parentId to
// the root; abandoned branches are left out.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { normalizeCreatedAt } from '../../core/session.js';

const TOOL_ARGS_MAX = 300;
const MAX_HEADER_BYTES = 1024 * 1024;

export function readPiSessionInfo(file) {
  const line = readFirstLine(file);
  let header;
  try {
    header = JSON.parse(line);
  } catch (err) {
    throw new Error(`${file}: invalid Pi session header: ${err.message}`);
  }
  if (header?.type !== 'session') throw new Error(`${file}: not a Pi session (no session header)`);
  return { session: header.id, ...readCreatedAt(file, header) };
}

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

  const { createdAt, createdAtError } = readCreatedAt(file, header);

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
    createdAt,
    createdAtError,
    messages: branch.filter((e) => e.type === 'message').flatMap((e) => toMessages(e.message)),
  };
}

function readCreatedAt(file, header) {
  try {
    return { createdAt: normalizeCreatedAt(header.timestamp, `${file}: session header timestamp`), createdAtError: null };
  } catch (err) {
    return { createdAt: null, createdAtError: err.message };
  }
}

function readFirstLine(file) {
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(8192);
  let text = '';
  let bytes = 0;
  try {
    while (bytes < MAX_HEADER_BYTES) {
      const size = Math.min(buffer.length, MAX_HEADER_BYTES - bytes);
      const read = fs.readSync(fd, buffer, 0, size, null);
      if (read === 0) break;
      bytes += read;
      text += decoder.write(buffer.subarray(0, read));
      const newline = text.indexOf('\n');
      if (newline >= 0) return text.slice(0, newline);
    }
    text += decoder.end();
    return text.split('\n').find((line) => line.trim() !== '') ?? '';
  } finally {
    fs.closeSync(fd);
  }
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

function toMessages(m) {
  if (!m) return [];
  if (m.role === 'user') {
    const text = contentText(m.content);
    return [text ? { role: 'user', text } : { role: 'user', text: '[empty message]' }];
  }
  if (m.role === 'assistant') {
    const messages = [];
    for (const c of m.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) messages.push({ role: 'assistant', text: c.text.trim() });
      if (c.type === 'toolCall') {
        messages.push({ role: 'toolCall', name: c.name, text: clip(JSON.stringify(c.arguments ?? {}), TOOL_ARGS_MAX) });
      }
    }
    return messages;
  }
  if (m.role === 'toolResult') {
    return [{ role: 'toolResult', name: m.toolName, text: contentText(m.content) }];
  }
  return []; // other roles (e.g. Pi's own bash/custom messages) are not part of v1
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

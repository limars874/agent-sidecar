// Storage layout (CONTRACT.md "Storage"). Every path the core or an adapter
// writes is derived here, so the tree stays the same for all agents.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/agent-sidecar.js');

export function rootDir(env = process.env) {
  return path.resolve(env.AGENT_SIDECAR_HOME || path.join(os.homedir(), '.agent-sidecar'));
}

export function itemsDir(root) {
  return path.join(root, 'items');
}

// Agent names and session ids become directory names: keep them to one safe segment.
export function safeSegment(value) {
  const s = String(value).replace(/[^A-Za-z0-9._-]/g, '_');
  return /^\.*$/.test(s) ? `_${s}` : s;
}

export function sessionDir(root, agent, session) {
  return path.join(root, 'state', safeSegment(agent), safeSegment(session));
}

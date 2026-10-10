// Where an item's result goes (CONTRACT.md "Outputs"). New output types are
// added here.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appendLine } from './state.js';
import { safeSegment, sessionOutputDir } from './paths.js';

export const TITLE_FILE = 'title.txt';
const TITLE_MAX = 80;
export const HERDR_SOURCE = 'agent-sidecar';

// ctx: { root, sessionDir, event, item, fromTurn, toTurn, now, env, sessionContext }
// Returns { written: string|null, warnings: string[] }.
export function applyOutput(output, text, ctx) {
  if (output.type === 'none') return { written: null, warnings: [] };
  if (output.type === 'title') return writeTitle(text, ctx);
  if (output.type === 'file') return writeFileOutput(output, text, ctx);
  throw new Error(`unknown output type ${output.type}`);
}

export function cleanTitle(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const title = line.replace(/^["'`]+|["'`]+$/g, '').replace(/^#+\s*/, '').trim();
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function writeTitle(text, ctx) {
  const title = cleanTitle(text);
  if (title === '') return { written: null, warnings: ['empty title, nothing written'] };
  const file = path.join(ctx.sessionDir, TITLE_FILE);
  fs.mkdirSync(ctx.sessionDir, { recursive: true });
  fs.writeFileSync(file, `${title}\n`);

  const warnings = [];
  if (ctx.event.pane) {
    const herdr = ctx.env.HERDR_BIN_PATH || 'herdr';
    const r = spawnSync(herdr, ['pane', 'report-metadata', ctx.event.pane, '--source', HERDR_SOURCE, '--title', title], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (r.error || r.status !== 0) warnings.push(`herdr title update failed: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
  }
  return { written: file, warnings };
}

export function expandPathTemplate(template, ctx) {
  const date = localDate(ctx.now);
  const vars = { agent: safeSegment(ctx.event.agent), session: safeSegment(ctx.event.session), item: ctx.item.name, date };
  const expanded = template.replace(/\{(\w+)\}/g, (all, key) => {
    if (key === 'sessionMonth') {
      if (!ctx.sessionContext?.sessionMonth) {
        const reason = ctx.sessionContext?.createdAtError ?? 'session createdAt is unavailable';
        throw new Error(`sessionMonth unavailable: ${reason}`);
      }
      return ctx.sessionContext.sessionMonth;
    }
    if (!(key in vars)) throw new Error(`unknown placeholder ${all} in output path`);
    return vars[key];
  });
  const withHome = expanded.startsWith('~/') ? path.join(ctx.env.HOME ?? '', expanded.slice(2)) : expanded;
  return path.resolve(ctx.root, withHome);
}

export function ensureSessionMetadata({ root, event, sessionContext }) {
  if (!sessionContext?.sessionMonth || !sessionContext.createdAt) {
    return {
      written: null,
      warning: `session metadata skipped: ${sessionContext?.createdAtError ?? 'session createdAt is unavailable'}`,
    };
  }

  const dir = sessionOutputDir(root, event.agent, sessionContext.sessionMonth, event.session);
  const file = path.join(dir, 'metadata.json');
  const metadata = {
    sessionId: event.session,
    agent: event.agent,
    createdAt: sessionContext.createdAt,
  };
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(metadata)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(temp, file);
      return { written: file, warning: null };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      readExistingMetadata(file, metadata);
      return { written: file, warning: null };
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function readExistingMetadata(file, expected) {
  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`metadata file ${file} is invalid: ${err.message}`);
  }
  if (
    !actual || actual.sessionId !== expected.sessionId ||
    actual.agent !== expected.agent || actual.createdAt !== expected.createdAt
  ) {
    throw new Error(`metadata file ${file} does not match the current session`);
  }
  return true;
}

function writeFileOutput(output, text, ctx) {
  const body = text.trim();
  if (body === '') return { written: null, warnings: [] }; // nothing to record this time
  const file = expandPathTemplate(output.path, ctx);
  if (output.mode === 'replace') {
    writeFileAtomic(file, `${body}\n`);
  } else {
    const header = `## ${ctx.now.toISOString()} · ${ctx.item.name} · ${ctx.event.agent} ${ctx.event.session} · turns ${ctx.fromTurn + 1}–${ctx.toTurn}`;
    appendLine(file, `${header}\n\n${body}\n`);
  }
  return { written: file, warnings: [] };
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

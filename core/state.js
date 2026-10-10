// Per-session state files and the lock that guards them. Each CLI process is
// short-lived; everything that must survive between events lives here.
import fs from 'node:fs';
import path from 'node:path';
import { emptyState } from './scheduler.js';

const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;
// A run is considered dead after this long without finishing, even if its pid lives on.
export const RUN_STALE_MS = 30 * 60 * 1000;

export function readState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function writeState(dir, state) {
  writeJsonAtomic(path.join(dir, 'state.json'), state);
}

// Runs fn(state) under the session lock and saves what it returns as the new state.
export function updateState(dir, fn) {
  return withLock(dir, () => {
    const result = fn(readState(dir));
    writeState(dir, result.state);
    return result;
  });
}

export function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockIsStale(lock)) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`);
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function lockIsStale(lock) {
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (pid) return !pidAlive(pid);
    return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false; // gone already, or unreadable: retry instead of stealing
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function runIsStale(running, now = Date.now()) {
  if (running.pid && !pidAlive(running.pid)) return true;
  return now - Date.parse(running.since) > RUN_STALE_MS;
}

export function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

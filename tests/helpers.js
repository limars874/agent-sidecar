import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const PI_SESSION = path.join(FIXTURES, 'pi-session.jsonl');
export const PI_SESSION_ID = '0199-test-session';
export const BIN = path.resolve(FIXTURES, '../../bin/agent-sidecar.js');

// A fresh storage root plus fake pi/herdr wired in through the environment.
export function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sidecar-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'home');
  fs.mkdirSync(path.join(root, 'items'), { recursive: true });
  const env = {
    ...process.env,
    AGENT_SIDECAR_HOME: root,
    AGENT_SIDECAR_PI_BIN: path.join(FIXTURES, 'fake-pi.js'),
    HERDR_BIN_PATH: path.join(FIXTURES, 'fake-herdr.js'),
    FAKE_PI_LOG: path.join(dir, 'pi.log'),
    FAKE_HERDR_LOG: path.join(dir, 'herdr.log'),
  };
  delete env.AGENT_SIDECAR_CHILD;
  delete env.AGENT_SIDECAR_DISABLE;
  return {
    dir,
    root,
    env,
    item(name, text) {
      fs.writeFileSync(path.join(root, 'items', name), text);
    },
    config(text) {
      fs.writeFileSync(path.join(root, 'config.yaml'), text);
    },
    piCalls: () => readJsonLines(env.FAKE_PI_LOG),
    herdrCalls: () => readJsonLines(env.FAKE_HERDR_LOG),
    stateDir: (session = PI_SESSION_ID) => path.join(root, 'state', 'pi', session),
  };
}

export function cli(args, env, input) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout.trim().split('\n').at(-1)) };
}

export function event(fields = {}) {
  return { v: 1, agent: 'pi', session: PI_SESSION_ID, transcriptRef: PI_SESSION, model: 'anthropic/session-model', pane: null, turn: 2, ...fields };
}

export function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function waitFor(check, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

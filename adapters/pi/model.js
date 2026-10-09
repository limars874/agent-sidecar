// Model calls for the CLI host: one headless `pi -p` per call, so Pi's own
// logins and model names are reused. The prompt goes on stdin.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { tail } from '../../core/runner.js';

// Keep the child bare: no tools, no session file, and no extensions, so the
// sidecar extension cannot trigger itself (AGENT_SIDECAR_CHILD guards it too).
// Only flags that released Pi versions accept: an unknown flag fails the call
// (--no-mcp is newer than the Pi this was tested against).
export const PI_ARGS = [
  '-p',
  '--no-session',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
];

export function callPiModel({ model, prompt, timeoutMs, env = process.env }) {
  const bin = env.AGENT_SIDECAR_PI_BIN || 'pi';
  const r = spawnSync(bin, [...PI_ARGS, '--model', model], {
    cwd: os.tmpdir(),
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...env, AGENT_SIDECAR_CHILD: '1' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(`pi -p failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`pi -p exited ${r.status}: ${tail(r.stderr)}`);
  return r.stdout.trim();
}

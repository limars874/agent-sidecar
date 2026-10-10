// Pi runner：通过一次性 `pi -p` 调用模型，复用 Pi 的登录和模型配置。
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { tail } from '../core/runner.js';

// 子进程保持最小权限，避免加载 session、tools、extensions 或项目上下文。
export const PI_ARGS = [
  '-p',
  '--no-session',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
];

const PI_EFFORT_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

// 显式 effort 优先于 Pi 模型名中的旧式 :level 后缀。
export function preparePiModel({ model, effort }) {
  if (!effort) return { model, effort: null };
  const match = model.match(PI_EFFORT_SUFFIX);
  return { model: match ? model.slice(0, match.index) : model, effort };
}

export function callPiModel({ model, effort, prompt, timeoutMs, env = process.env }) {
  const bin = env.AGENT_SIDECAR_PI_BIN || 'pi';
  const selected = preparePiModel({ model, effort });
  const args = [...PI_ARGS, '--model', selected.model];
  if (selected.effort) args.push('--thinking', selected.effort);
  const r = spawnSync(bin, args, {
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

export default {
  name: 'pi',
  callModel: callPiModel,
};

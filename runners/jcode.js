// Jcode runner：调用 jcode 的无状态单次命令，并解析 --json 返回的 text。
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { tail } from '../core/runner.js';

const JCODE_EFFORT_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;
const PROVIDER_MAP = Object.freeze({
  'openai-codex': 'openai',
  openai: 'openai',
  'openai-api': 'openai-api',
  anthropic: 'claude',
  claude: 'claude',
  gemini: 'gemini',
  google: 'google',
  opencode: 'opencode',
  'opencode-go': 'opencode-go',
  xai: 'xai',
  'grok-build': 'grok-build',
});

// Jcode 使用裸 model id；Pi 风格的 provider/id 和 :effort 后缀在这里转换。
export function normalizeJcodeModel(model, { providerProfile = null } = {}) {
  const withoutSuffix = model.replace(JCODE_EFFORT_SUFFIX, '');
  const slash = withoutSuffix.indexOf('/');
  if (slash < 0) return { model: withoutSuffix, provider: null, providerProfile };

  const providerName = withoutSuffix.slice(0, slash);
  const modelId = withoutSuffix.slice(slash + 1);
  if (providerProfile) return { model: modelId, provider: null, providerProfile };

  const provider = PROVIDER_MAP[providerName];
  return {
    model: provider ? modelId : withoutSuffix,
    provider: provider ?? null,
    providerProfile: null,
  };
}

export function buildJcodeArgs({ model, env = process.env }) {
  const providerProfile = env.AGENT_SIDECAR_JCODE_PROVIDER_PROFILE?.trim() || null;
  const selected = normalizeJcodeModel(model, { providerProfile });
  const args = [
    'run',
    '--json',
    '--quiet',
    '--no-update',
    '--no-selfdev',
    '--tool-profile',
    'none',
    '--cwd',
    os.tmpdir(),
  ];
  if (selected.providerProfile) args.push('--provider-profile', selected.providerProfile);
  else if (selected.provider) args.push('--provider', selected.provider);
  args.push('--model', selected.model);
  return args;
}

export function callJcodeModel({ model, prompt, timeoutMs, env = process.env }) {
  const bin = env.AGENT_SIDECAR_JCODE_BIN || 'jcode';
  // jcode v0.93.0 没有 run 级别的 effort 参数，思考档位沿用 ~/.jcode/config.toml。
  const r = spawnSync(bin, [...buildJcodeArgs({ model, env }), '--', prompt], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...env, JCODE_NON_INTERACTIVE: '1', JCODE_RUN_MCP: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new Error(`jcode run failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`jcode run exited ${r.status}: ${tail(r.stderr)}`);

  let report;
  try {
    report = JSON.parse(r.stdout.trim());
  } catch (error) {
    throw new Error(`jcode --json returned invalid JSON: ${error.message}`);
  }
  if (!report || typeof report.text !== 'string') throw new Error('jcode --json result has no text field');
  return report.text.trim();
}

export default {
  name: 'jcode',
  callModel: callJcodeModel,
};

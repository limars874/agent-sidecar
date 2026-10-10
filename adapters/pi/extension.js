// Pi extension: the in-process half of the Pi adapter. It only reports
// finished turns to the CLI host and shows titles the host wrote; all item
// work happens in the CLI. Install this repository as a Pi package.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TITLE_FILE } from '../../core/outputs.js';
import { loadConfig } from '../../core/config.js';
import { rootDir, sessionDir } from '../../core/paths.js';

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(EXTENSION_DIR, '../../bin/agent-sidecar.js');
const TITLE_POLL_MS = 1000;
const HERDR_SOURCE = 'agent-sidecar';

// 清除 sidecar 自己管理的两套 Herdr 标题；这是生命周期动作，不是 item 输出。
function clearPaneTitle(pane, env) {
  if (!pane) return [];
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const commands = [
    ['pane', 'rename', pane, '--clear'],
    ['pane', 'report-metadata', pane, '--source', HERDR_SOURCE, '--clear-title'],
  ];
  const warnings = [];
  for (const args of commands) {
    const r = spawnSync(herdr, args, { encoding: 'utf8', timeout: 10000, env });
    if (r.error || r.status !== 0) {
      warnings.push(`herdr title clear failed: ${(r.error?.message ?? r.stderr ?? '').trim()}`);
    }
  }
  return warnings;
}

export function buildEvent(ctx, env = process.env) {
  const sm = ctx.sessionManager;
  const transcriptRef = sm.getSessionFile();
  if (!transcriptRef) return null; // --no-session: nothing on disk for the CLI to read
  return {
    v: 1,
    agent: 'pi',
    session: sm.getSessionId(),
    transcriptRef,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    pane: env.HERDR_PANE_ID || null,
    turn: sm.getBranch().filter((e) => e.type === 'message' && e.message?.role === 'user').length,
  };
}

// Pi calls the default export with its extension API only; tests pass their own env.
export function createExtension(env) {
  return (pi) => register(pi, env);
}

export default createExtension(process.env);

function register(pi, env) {
  // AGENT_SIDECAR_CHILD: this Pi is the sidecar's own `pi -p` model call.
  if (env.AGENT_SIDECAR_CHILD || env.AGENT_SIDECAR_DISABLE) return;

  let warned = false;
  let stopTitleWatch = () => {};

  const emit = (ctx) => {
    const event = buildEvent(ctx, env);
    if (!event) return;
    const child = spawn(env.AGENT_SIDECAR_NODE || 'node', [BIN, 'event', '--json', JSON.stringify(event)], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.on('error', (err) => {
      if (!warned && ctx.hasUI) ctx.ui.notify(`agent-sidecar: cannot start the CLI (${err.message})`, 'warning');
      warned = true;
    });
    child.unref();
  };

  // CLI host 将标题写入 session state；只有 agent 自己能设置 terminal title，
  // 因此由当前 extension 轮询并应用。
  const watchTitle = (ctx, { applyExisting = true } = {}) => {
    stopTitleWatch();
    const file = path.join(sessionDir(rootDir(env), 'pi', ctx.sessionManager.getSessionId()), TITLE_FILE);
    let shown;
    let initialized = false;
    const apply = () => {
      let title;
      try {
        title = fs.readFileSync(file, 'utf8').trim();
      } catch {
        initialized = true;
        return;
      }
      if (!initialized) {
        initialized = true;
        if (!applyExisting) {
          shown = title;
          return;
        }
      }
      if (title && title !== shown) {
        shown = title;
        ctx.ui.setTitle(title);
      }
    };
    apply();
    fs.watchFile(file, { interval: TITLE_POLL_MS, persistent: false }, apply);
    stopTitleWatch = () => fs.unwatchFile(file, apply);
  };

  const clearTitleAtSessionStart = (event, ctx) => {
    if (!ctx.hasUI) return false;
    const setting = event?.reason === 'new'
      ? 'clearTitleOnNew'
      : event?.reason === 'resume'
        ? 'clearTitleOnResume'
        : null;
    if (!setting) return false;

    let config;
    try {
      config = loadConfig(rootDir(env));
    } catch (err) {
      ctx.ui.notify(`agent-sidecar: lifecycle config ignored (${err.message})`, 'warning');
      return false;
    }
    if (!config.lifecycle[setting]) return false;

    for (const warning of clearPaneTitle(env.HERDR_PANE_ID, env)) {
      ctx.ui.notify(warning, 'warning');
    }
    return true;
  };

  pi.on('session_start', async (event, ctx) => {
    if (!ctx.hasUI) return;
    const cleared = clearTitleAtSessionStart(event, ctx);
    watchTitle(ctx, { applyExisting: !cleared });
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (!event.aborted) emit(ctx);
  });
  pi.on('session_shutdown', async () => {
    stopTitleWatch();
  });
}

// Pi extension: the in-process half of the Pi adapter. It only reports
// finished turns to the CLI host and shows titles the host wrote; all item
// work happens in the CLI. Install: symlink this file into ~/.pi/agent/extensions/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 通过真实文件路径解析包内模块；Pi 从 symlink 加载全局 extension 时，
// 静态相对 import 会错误地从 ~/.pi/agent/extensions 解析，而不是从仓库解析。
const EXTENSION_DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const [{ TITLE_FILE }, { rootDir, sessionDir }] = await Promise.all([
  import(pathToFileURL(path.resolve(EXTENSION_DIR, '../../core/outputs.js')).href),
  import(pathToFileURL(path.resolve(EXTENSION_DIR, '../../core/paths.js')).href),
]);

// Resolve through the symlink so the CLI is found next to the real file.
const BIN = path.resolve(EXTENSION_DIR, '../../bin/agent-sidecar.js');
const TITLE_POLL_MS = 1000;

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

  // The CLI host writes titles to the session's state directory; apply them here,
  // since only the agent's own process can set its terminal title.
  const watchTitle = (ctx) => {
    stopTitleWatch();
    const file = path.join(sessionDir(rootDir(env), 'pi', ctx.sessionManager.getSessionId()), TITLE_FILE);
    let shown;
    const apply = () => {
      let title;
      try {
        title = fs.readFileSync(file, 'utf8').trim();
      } catch {
        return;
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

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI) watchTitle(ctx);
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (!event.aborted) emit(ctx);
  });
  pi.on('session_shutdown', async () => {
    stopTitleWatch();
  });
}

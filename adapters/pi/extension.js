// Pi extension: the in-process half of the Pi adapter. It only reports
// finished turns to the CLI host and shows titles the host wrote; all item
// work happens in the CLI. Install this repository as a Pi package.
import { spawn, spawnSync } from 'node:child_process';
import { connect as connectNats } from '@nats-io/transport-node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadItems } from '../../core/items.js';
import { TITLE_FILE } from '../../core/outputs.js';
import { createFeedbackRoute, FEEDBACK_MAX_PAYLOAD_BYTES, natsConnectionOptions, safeFeedbackErrorMessage, validateFeedbackEnvelope } from '../../core/feedback.js';
import { loadConfig } from '../../core/config.js';
import { itemsDir, rootDir, sessionDir } from '../../core/paths.js';

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(EXTENSION_DIR, '../../bin/agent-sidecar.js');
const TITLE_POLL_MS = 1000;
const HERDR_SOURCE = 'agent-sidecar';
const FEEDBACK_RETRY_MS = 5000;
const feedbackDecoder = new TextDecoder('utf-8', { fatal: true });

function hasFeedbackItem(root) {
  return loadItems(itemsDir(root)).items.some((item) => item.feedback);
}

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

export function buildEvent(ctx, env = process.env, feedbackRoute = null) {
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
    ...(feedbackRoute ? { feedbackRoute } : {}),
  };
}

// Pi calls the default export with its extension API only; tests pass their own env.
export function createExtension(env, dependencies = {}) {
  return (pi) => register(pi, env, dependencies);
}

export default createExtension(process.env);

function register(pi, env, dependencies = {}) {
  // AGENT_SIDECAR_CHILD: this Pi is the sidecar's own `pi -p` model call.
  if (env.AGENT_SIDECAR_CHILD || env.AGENT_SIDECAR_DISABLE) return;

  const natsConnect = dependencies.connectNats ?? connectNats;
  const spawnProcess = dependencies.spawn ?? spawn;
  const makeFeedbackRoute = dependencies.createFeedbackRoute ?? createFeedbackRoute;
  const currentSessionId = (ctx) => {
    try {
      return ctx?.sessionManager?.getSessionId?.() ?? null;
    } catch {
      return null;
    }
  };
  let warned = false;
  let stopTitleWatch = () => {};
  let activeCtx = null;
  let feedbackConnection = null;
  let feedbackSubscription = null;
  let feedbackRoute = null;
  let feedbackGeneration = 0;
  let feedbackRetryTimer = null;
  let feedbackStartingGeneration = null;
  let feedbackStartPromise = null;
  let feedbackWarningShown = false;
  const seenFeedbackIds = new Set();

  const warnFeedback = (ctx, message) => {
    if (feedbackWarningShown) return;
    feedbackWarningShown = true;
    console.warn(`agent-sidecar feedback: ${message}`);
    if (ctx?.hasUI) ctx.ui.notify(`agent-sidecar feedback: ${message}`, 'warning');
  };

  const scheduleFeedbackRetry = (ctx, generation) => {
    if (feedbackRetryTimer || generation !== feedbackGeneration) return;
    feedbackRetryTimer = setTimeout(() => {
      feedbackRetryTimer = null;
      void startFeedback(ctx, generation);
    }, FEEDBACK_RETRY_MS);
    feedbackRetryTimer.unref?.();
  };

  const stopFeedback = async () => {
    feedbackGeneration += 1;
    if (feedbackRetryTimer) clearTimeout(feedbackRetryTimer);
    feedbackRetryTimer = null;
    feedbackRoute = null;
    const subscription = feedbackSubscription;
    const connection = feedbackConnection;
    feedbackSubscription = null;
    feedbackConnection = null;
    if (subscription) subscription.unsubscribe();
    if (connection) {
      try {
        await connection.close();
      } catch {
        // 会话关闭采用尽力而为，不能让清理失败影响用户退出。
      }
    }
  };

  const deliverFeedback = (ctx, route, generation, message) => {
    if (generation !== feedbackGeneration || activeCtx !== ctx) return;
    if (message.data.byteLength > FEEDBACK_MAX_PAYLOAD_BYTES) {
      console.warn('agent-sidecar feedback: oversized message dropped');
      return;
    }

    let envelope;
    try {
      envelope = validateFeedbackEnvelope(JSON.parse(feedbackDecoder.decode(message.data)));
    } catch (err) {
      console.warn(`agent-sidecar feedback: invalid message dropped (${err.message})`);
      return;
    }

    let currentSession;
    try {
      currentSession = ctx.sessionManager.getSessionId();
    } catch {
      currentSession = null;
    }
    if (envelope.agent !== 'pi' || envelope.instanceId !== route.instanceId || envelope.session !== route.session || envelope.session !== currentSession) {
      console.warn('agent-sidecar feedback: stale or misrouted message dropped');
      return;
    }
    if (seenFeedbackIds.has(envelope.id)) return;
    seenFeedbackIds.add(envelope.id);
    if (seenFeedbackIds.size > 100) seenFeedbackIds.delete(seenFeedbackIds.values().next().value);

    const deliverAs = ctx.isIdle() ? 'nextTurn' : 'steer';
    try {
      pi.sendMessage({
        customType: 'agent-sidecar-feedback',
        content: `Agent-sidecar feedback (advisory):\n\n${envelope.content}`,
        display: true,
        details: envelope,
      }, { deliverAs });
    } catch (err) {
      console.warn(`agent-sidecar feedback: Pi delivery failed (${err.message})`);
    }
  };

  const consumeFeedback = async (subscription, ctx, route, generation) => {
    try {
      for await (const message of subscription) deliverFeedback(ctx, route, generation, message);
    } catch (err) {
      if (generation === feedbackGeneration) {
        warnFeedback(ctx, `subscription stopped (${err.message})`);
        scheduleFeedbackRetry(ctx, generation);
      }
    }
  };

  async function startFeedbackImpl(ctx, generation = feedbackGeneration) {
    if (generation !== feedbackGeneration || activeCtx !== ctx || !hasFeedbackItem(rootDir(env))) return;

    let config;
    try {
      config = loadConfig(rootDir(env));
    } catch (err) {
      warnFeedback(ctx, `configuration ignored (${safeFeedbackErrorMessage(err)})`);
      return;
    }

    const route = makeFeedbackRoute(ctx.sessionManager.getSessionId());
    try {
      const connection = await natsConnect(natsConnectionOptions(config.feedback.natsUrl, {
        name: 'agent-sidecar-feedback-pi',
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1000,
        waitOnFirstConnect: false,
        timeout: 1500,
      }));
      if (generation !== feedbackGeneration || activeCtx !== ctx) {
        await connection.close();
        return;
      }
      feedbackRoute = route;
      feedbackConnection = connection;
      feedbackSubscription = connection.subscribe(route.replySubject);
      feedbackWarningShown = false;
      void consumeFeedback(feedbackSubscription, ctx, route, generation);
      void connection.closed().then((err) => {
        if (generation !== feedbackGeneration) return;
        feedbackConnection = null;
        feedbackSubscription = null;
        if (err) {
          warnFeedback(ctx, `connection closed (${safeFeedbackErrorMessage(err)})`);
          scheduleFeedbackRetry(ctx, generation);
        }
      });
    } catch (err) {
      if (generation === feedbackGeneration) {
        warnFeedback(ctx, `NATS unavailable (${safeFeedbackErrorMessage(err)})`);
        scheduleFeedbackRetry(ctx, generation);
      }
    }
  }

  function startFeedback(ctx, generation = feedbackGeneration) {
    if (feedbackStartingGeneration === generation && feedbackStartPromise) return feedbackStartPromise;
    feedbackStartingGeneration = generation;
    const promise = startFeedbackImpl(ctx, generation);
    feedbackStartPromise = promise;
    return promise.finally(() => {
      if (feedbackStartingGeneration === generation) {
        feedbackStartingGeneration = null;
        feedbackStartPromise = null;
      }
    });
  }

  const emit = async (ctx) => {
    if (!feedbackConnection && hasFeedbackItem(rootDir(env))) await startFeedback(ctx);
    const route = feedbackConnection && feedbackRoute?.session === currentSessionId(ctx) ? feedbackRoute : null;
    const event = buildEvent(ctx, env, route);
    if (!event) return;
    const child = spawnProcess(env.AGENT_SIDECAR_NODE || 'node', [BIN, 'event', '--json', JSON.stringify(event)], {
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
    await stopFeedback();
    activeCtx = ctx;
    void startFeedback(ctx);
    if (!ctx.hasUI) return;
    const cleared = clearTitleAtSessionStart(event, ctx);
    watchTitle(ctx, { applyExisting: !cleared });
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (!event.aborted) await emit(ctx);
  });
  pi.on('session_shutdown', async () => {
    activeCtx = null;
    stopTitleWatch();
    await stopFeedback();
  });
}

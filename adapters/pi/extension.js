// Pi extension: the in-process half of the Pi adapter. It reports finished
// turns to the CLI host, applies titles, and receives optional NATS messages.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jetstreamManager as defaultJetstreamManager } from '@nats-io/jetstream';
import { connect as connectNats } from '@nats-io/transport-node';
import { loadItems } from '../../core/items.js';
import { TITLE_FILE } from '../../core/outputs.js';
import {
  createFeedbackRoute,
  FEEDBACK_MAX_PAYLOAD_BYTES,
  natsConnectionOptions,
  safeFeedbackErrorMessage,
  validateFeedbackEnvelope,
} from '../../core/feedback.js';
import {
  createHandoffRoute,
  decodeHandoffMessage,
  deleteHandoffConsumer,
  ensureHandoffConsumer,
  ensureHandoffStream,
  HANDOFF_MAX_PAYLOAD_BYTES,
} from '../../core/idle-handoff.js';
import { loadConfig } from '../../core/config.js';
import { itemsDir, rootDir, sessionDir } from '../../core/paths.js';

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(EXTENSION_DIR, '../../bin/agent-sidecar.js');
const TITLE_POLL_MS = 1000;
const HERDR_SOURCE = 'agent-sidecar';
const FEEDBACK_RETRY_MS = 5000;
const NATS_SETUP_TIMEOUT_MS = 3000;
const feedbackDecoder = new TextDecoder('utf-8', { fatal: true });

function hasFeedbackItem(root) {
  return loadItems(itemsDir(root)).items.some((item) => item.feedback);
}

function currentTurnAndProgress(ctx) {
  const branch = ctx.sessionManager.getBranch();
  const users = branch.filter((entry) => entry.type === 'message' && entry.message?.role === 'user');
  return {
    turn: users.length,
    progressId: typeof users.at(-1)?.id === 'string' ? users.at(-1).id : null,
  };
}

function readPendingHandoff(ctx) {
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
  const seenIds = new Set();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== 'agent-sidecar-handoff') continue;
    const data = entry.data ?? {};
    if (typeof data.id !== 'string' || data.id === '' || seenIds.has(data.id)) continue;
    seenIds.add(data.id);
    if (data.status !== 'triggered' || !Number.isInteger(data.workTurn)) continue;
    const progress = currentTurnAndProgress(ctx);
    if (progress.turn !== data.workTurn || (data.progressId && data.progressId !== progress.progressId)) return null;
    return { id: data.id, workTurn: data.workTurn, progressId: data.progressId ?? null };
  }
  return null;
}

function appendHandoffMarker(pi, value) {
  try {
    pi.appendEntry('agent-sidecar-handoff', value);
  } catch (err) {
    console.warn(`agent-sidecar idle handoff marker failed: ${err.message}`);
  }
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

export function buildEvent(ctx, env = process.env, feedbackRoute = null, handoffRoute = null, activity = null, handoffId = null) {
  const sm = ctx.sessionManager;
  const transcriptRef = sm.getSessionFile();
  if (!transcriptRef) return null; // --no-session: nothing on disk for the CLI to read
  const progress = currentTurnAndProgress(ctx);
  const event = {
    v: 1,
    agent: 'pi',
    session: sm.getSessionId(),
    transcriptRef,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    pane: env.HERDR_PANE_ID || null,
    turn: progress.turn,
  };
  if (progress.progressId) event.progressId = progress.progressId;
  if (feedbackRoute) event.feedbackRoute = feedbackRoute;
  if (handoffRoute) event.handoffRoute = handoffRoute;
  if (activity) event.activity = activity;
  if (handoffId) event.handoffId = handoffId;
  return event;
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
  const getJetStreamManager = dependencies.jetstreamManager ?? defaultJetstreamManager;
  const spawnProcess = dependencies.spawn ?? spawn;
  const makeFeedbackRoute = dependencies.createFeedbackRoute ?? createFeedbackRoute;
  const makeHandoffRoute = dependencies.createHandoffRoute ?? createHandoffRoute;
  const currentSessionId = (ctx) => {
    try {
      return ctx?.sessionManager?.getSessionId?.() ?? null;
    } catch {
      return null;
    }
  };
  let warned = false;
  let stopTitleWatch = () => {};
  let activeSession = null;
  let feedbackConnection = null;
  let feedbackSubscription = null;
  let handoffSubscription = null;
  let handoffManager = null;
  let feedbackRoute = null;
  let handoffRoute = null;
  let handoffInFlight = null;
  let feedbackGeneration = 0;
  let feedbackRetryTimer = null;
  let handoffRetryTimer = null;
  let feedbackStartingGeneration = null;
  let feedbackStartPromise = null;
  let feedbackWarningShown = false;
  const seenFeedbackIds = new Set();
  const seenHandoffIds = new Set();

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

  const scheduleHandoffRetry = (ctx, generation) => {
    if (handoffRetryTimer || generation !== feedbackGeneration) return;
    handoffRetryTimer = setTimeout(() => {
      handoffRetryTimer = null;
      void startFeedback(ctx, generation);
    }, FEEDBACK_RETRY_MS);
    handoffRetryTimer.unref?.();
  };

  const stopFeedback = async () => {
    feedbackGeneration += 1;
    if (feedbackRetryTimer) clearTimeout(feedbackRetryTimer);
    if (handoffRetryTimer) clearTimeout(handoffRetryTimer);
    feedbackRetryTimer = null;
    handoffRetryTimer = null;
    const manager = handoffManager;
    const route = handoffRoute;
    const subscription = feedbackSubscription;
    const handoffSub = handoffSubscription;
    const connection = feedbackConnection;
    feedbackSubscription = null;
    handoffSubscription = null;
    handoffManager = null;
    feedbackConnection = null;
    feedbackRoute = null;
    handoffRoute = null;
    handoffInFlight = null;
    if (subscription) subscription.unsubscribe();
    if (handoffSub) handoffSub.unsubscribe();
    if (manager && route) await deleteHandoffConsumer(manager, route);
    if (connection) {
      try {
        await connection.close();
      } catch {
        // 会话关闭采用尽力而为，不能让清理失败影响用户退出。
      }
    }
  };

  const deliverFeedback = (ctx, route, generation, message) => {
    if (generation !== feedbackGeneration || currentSessionId(ctx) !== route.session) return;
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

  const reportHandoff = (ctx, activity, handoffId) => {
    const event = buildEvent(ctx, env, null, null, activity, handoffId);
    if (!event) return;
    spawnEvent(ctx, event);
  };

  const deliverHandoff = (ctx, route, generation, message) => {
    if (generation !== feedbackGeneration || currentSessionId(ctx) !== route.session) return;
    if (message.data.byteLength > HANDOFF_MAX_PAYLOAD_BYTES) {
      warnFeedback(ctx, 'idle handoff oversized message dropped');
      return;
    }

    let envelope;
    try {
      envelope = decodeHandoffMessage(message.data);
    } catch (err) {
      warnFeedback(ctx, `idle handoff invalid message dropped (${err.message})`);
      return;
    }
    const progress = currentTurnAndProgress(ctx);
    if (envelope.agent !== 'pi' || envelope.instanceId !== route.instanceId || envelope.session !== route.session || envelope.session !== currentSessionId(ctx)) {
      console.warn('agent-sidecar idle handoff: stale or misrouted message dropped');
      return;
    }
    if (progress.turn !== envelope.workTurn || (envelope.progressId && envelope.progressId !== progress.progressId)) {
      console.warn('agent-sidecar idle handoff: old work progress dropped');
      return;
    }
    if (!ctx.isIdle()) {
      console.warn('agent-sidecar idle handoff: Pi is no longer idle; message dropped');
      return;
    }
    if (seenHandoffIds.has(envelope.id)) return;
    seenHandoffIds.add(envelope.id);
    if (seenHandoffIds.size > 100) seenHandoffIds.delete(seenHandoffIds.values().next().value);

    handoffInFlight = { id: envelope.planId, workTurn: envelope.workTurn, progressId: envelope.progressId ?? null };
    appendHandoffMarker(pi, {
      v: 1,
      id: envelope.planId,
      workTurn: envelope.workTurn,
      progressId: envelope.progressId ?? null,
      status: 'triggered',
    });
    reportHandoff(ctx, 'handoff-triggered', envelope.planId);
    try {
      pi.sendMessage({
        customType: 'agent-sidecar-handoff',
        content: `Agent-sidecar idle handoff:\n\n${envelope.prompt}`,
        display: true,
        details: envelope,
      }, { deliverAs: 'steer', triggerTurn: true });
    } catch (err) {
      console.warn(`agent-sidecar idle handoff: Pi wake failed (${err.message})`);
    }
  };

  const consumeFeedback = async (subscription, ctx, route, generation) => {
    try {
      for await (const message of subscription) deliverFeedback(ctx, route, generation, message);
    } catch (err) {
      if (generation === feedbackGeneration) {
        if (feedbackSubscription === subscription) feedbackSubscription = null;
        warnFeedback(ctx, `subscription stopped (${safeFeedbackErrorMessage(err)})`);
        scheduleFeedbackRetry(ctx, generation);
      }
    }
  };

  const consumeHandoff = async (subscription, ctx, route, generation) => {
    try {
      for await (const message of subscription) deliverHandoff(ctx, route, generation, message);
    } catch (err) {
      if (generation === feedbackGeneration) {
        if (handoffSubscription === subscription) handoffSubscription = null;
        handoffManager = null;
        warnFeedback(ctx, `idle handoff subscription stopped (${safeFeedbackErrorMessage(err)})`);
        scheduleFeedbackRetry(ctx, generation);
      }
    }
  };

  async function setupHandoffSubscription(ctx, generation, connection, route) {
    let manager = null;
    try {
      manager = await withTimeout(getJetStreamManager(connection), NATS_SETUP_TIMEOUT_MS, 'JetStream manager');
      await withTimeout(ensureHandoffStream(manager), NATS_SETUP_TIMEOUT_MS, 'JetStream stream');
      await withTimeout(ensureHandoffConsumer(manager, route), NATS_SETUP_TIMEOUT_MS, 'JetStream consumer');
      const subscription = connection.subscribe(route.replySubject);
      if (generation !== feedbackGeneration || currentSessionId(ctx) !== activeSession) {
        subscription.unsubscribe();
        await deleteHandoffConsumer(manager, route);
        return false;
      }
      handoffManager = manager;
      handoffRoute = route;
      handoffSubscription = subscription;
      void consumeHandoff(subscription, ctx, route, generation);
      return true;
    } catch (err) {
      if (manager) await deleteHandoffConsumer(manager, route);
      throw new Error(`idle handoff setup failed (${safeFeedbackErrorMessage(err)})`);
    }
  }

  async function startFeedbackImpl(ctx, generation = feedbackGeneration) {
    if (generation !== feedbackGeneration || currentSessionId(ctx) !== activeSession) return;

    let config;
    try {
      config = loadConfig(rootDir(env));
    } catch (err) {
      warnFeedback(ctx, `configuration ignored (${safeFeedbackErrorMessage(err)})`);
      return;
    }
    const wantsFeedback = hasFeedbackItem(rootDir(env));
    const wantsHandoff = config.idleHandoff.enabled === true;
    if (!wantsFeedback && !wantsHandoff) return;

    if (feedbackConnection && currentSessionId(ctx) === activeSession) {
      try {
        if (wantsFeedback && !feedbackSubscription) {
          feedbackRoute ??= makeFeedbackRoute(ctx.sessionManager.getSessionId());
          feedbackSubscription = feedbackConnection.subscribe(feedbackRoute.replySubject);
          void consumeFeedback(feedbackSubscription, ctx, feedbackRoute, generation);
        }
        if (wantsHandoff && !handoffSubscription) {
          const route = handoffRoute ?? makeHandoffRoute(ctx.sessionManager.getSessionId());
          await setupHandoffSubscription(ctx, generation, feedbackConnection, route);
          if (handoffRetryTimer) clearTimeout(handoffRetryTimer);
          handoffRetryTimer = null;
        }
      } catch (err) {
        warnFeedback(ctx, safeFeedbackErrorMessage(err));
        scheduleFeedbackRetry(ctx, generation);
      }
      return;
    }

    const nextFeedbackRoute = wantsFeedback ? (feedbackRoute ?? makeFeedbackRoute(ctx.sessionManager.getSessionId())) : null;
    const nextHandoffRoute = wantsHandoff ? (handoffRoute ?? makeHandoffRoute(ctx.sessionManager.getSessionId())) : null;
    let connection;
    try {
      connection = await natsConnect(natsConnectionOptions(config.feedback.natsUrl, {
        name: 'agent-sidecar-feedback-pi',
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1000,
        waitOnFirstConnect: false,
        timeout: 1500,
      }));
      if (generation !== feedbackGeneration || currentSessionId(ctx) !== activeSession) {
        await connection.close();
        return;
      }

      feedbackConnection = connection;
      feedbackRoute = nextFeedbackRoute;
      feedbackSubscription = nextFeedbackRoute ? connection.subscribe(nextFeedbackRoute.replySubject) : null;
      feedbackWarningShown = false;
      if (feedbackSubscription) void consumeFeedback(feedbackSubscription, ctx, nextFeedbackRoute, generation);

      if (nextHandoffRoute) {
        try {
          await setupHandoffSubscription(ctx, generation, connection, nextHandoffRoute);
        } catch (err) {
          warnFeedback(ctx, safeFeedbackErrorMessage(err));
          scheduleHandoffRetry(ctx, generation);
        }
      }

      void connection.closed().then((err) => {
        if (generation !== feedbackGeneration) return;
        feedbackConnection = null;
        feedbackSubscription = null;
        handoffSubscription = null;
        handoffManager = null;
        if (err) {
          warnFeedback(ctx, `connection closed (${safeFeedbackErrorMessage(err)})`);
          scheduleFeedbackRetry(ctx, generation);
        }
      });
    } catch (err) {
      if (connection) {
        try { await connection.close(); } catch { /* 已经失败，忽略关闭异常。 */ }
      }
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

  function spawnEvent(ctx, event) {
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
  }

  const emit = async (ctx, { activity = null, handoffId = null } = {}) => {
    if (!feedbackConnection) await startFeedback(ctx);
    const session = currentSessionId(ctx);
    const activeFeedbackRoute = feedbackConnection && feedbackRoute?.session === session ? feedbackRoute : null;
    const activeHandoffRoute = feedbackConnection && handoffRoute?.session === session ? handoffRoute : null;
    const event = buildEvent(ctx, env, activeFeedbackRoute, activeHandoffRoute, activity, handoffId);
    if (!event) return;
    spawnEvent(ctx, event);
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
    activeSession = currentSessionId(ctx);
    handoffInFlight = readPendingHandoff(ctx);
    void startFeedback(ctx);
    if (!ctx.hasUI) return;
    const cleared = clearTitleAtSessionStart(event, ctx);
    watchTitle(ctx, { applyExisting: !cleared });
  });
  pi.on('agent_settled', async (event, ctx) => {
    const pending = handoffInFlight;
    const progress = pending ? currentTurnAndProgress(ctx) : null;
    const isHandoff = pending && progress.turn === pending.workTurn && (!pending.progressId || pending.progressId === progress.progressId);
    if (isHandoff && !event.aborted) {
      handoffInFlight = null;
      appendHandoffMarker(pi, { v: 1, id: pending.id, workTurn: pending.workTurn, status: 'completed' });
      await emit(ctx, { activity: 'handoff', handoffId: pending.id });
      return;
    }
    if (isHandoff && event.aborted) return;
    if (pending) handoffInFlight = null;
    if (!event.aborted) await emit(ctx);
  });
  pi.on('session_shutdown', async () => {
    activeSession = null;
    stopTitleWatch();
    await stopFeedback();
  });
}

function withTimeout(promise, timeoutMs, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`idle handoff ${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

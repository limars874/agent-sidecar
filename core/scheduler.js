// Decides which items are due for an event. Pure: takes the stored session
// state and returns the new one, so the caller can save it under the lock.

// state: { v: 1, items: { [name]: { lastTurn, scheduledThrough, completedThrough, running?, lastRun? } } }
export function emptyState() {
  return { v: 1, items: {} };
}

export function planEvent({ items, state, turn, job, now, isStale }) {
  const next = structuredClone(state);
  const due = [];
  const skipped = [];

  for (const item of items) {
    const s = (next.items[item.name] ??= { lastTurn: 0 });
    migrateCursor(s);

    // The branch got shorter (Pi /tree, fork): restart counting from here.
    if (turn < s.completedThrough) s.completedThrough = turn;
    if (turn < s.scheduledThrough) s.scheduledThrough = turn;
    s.lastTurn = s.completedThrough;

    if (turn - s.completedThrough < item.everyTurns) {
      skipped.push({ name: item.name, reason: 'not_due' });
      continue;
    }
    if (s.running && !isStale(s.running)) {
      skipped.push({ name: item.name, reason: 'running' });
      continue;
    }

    const scope = item.contextSpec?.scope ?? item.context ?? 'delta';
    due.push({ name: item.name, fromTurn: scope === 'session' ? 0 : s.completedThrough, toTurn: turn });
    s.scheduledThrough = turn;
    s.running = { job, since: now };
  }
  return { due, skipped, state: next };
}

function migrateCursor(state) {
  const legacy = Number.isInteger(state.lastTurn) ? state.lastTurn : 0;
  if (!Number.isInteger(state.completedThrough)) state.completedThrough = legacy;
  if (!Number.isInteger(state.scheduledThrough)) state.scheduledThrough = legacy;
  if (!Number.isInteger(state.lastTurn)) state.lastTurn = state.completedThrough;
}

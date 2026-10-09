// Decides which items are due for an event. Pure: takes the stored session
// state and returns the new one, so the caller can save it under the lock.

// state: { v: 1, items: { [name]: { lastTurn, running?: { job, pid?, since }, lastRun? } } }
export function emptyState() {
  return { v: 1, items: {} };
}

export function planEvent({ items, state, turn, job, now, isStale }) {
  const next = structuredClone(state);
  const due = [];
  const skipped = [];

  for (const item of items) {
    const s = (next.items[item.name] ??= { lastTurn: 0 });
    // The branch got shorter (Pi /tree, fork): restart counting from here.
    if (turn < s.lastTurn) s.lastTurn = turn;

    if (turn - s.lastTurn < item.everyTurns) {
      skipped.push({ name: item.name, reason: 'not_due' });
      continue;
    }
    if (s.running && !isStale(s.running)) {
      skipped.push({ name: item.name, reason: 'running' });
      continue;
    }
    due.push({ name: item.name, fromTurn: item.context === 'session' ? 0 : s.lastTurn, toTurn: turn });
    s.lastTurn = turn;
    s.running = { job, since: now };
  }
  return { due, skipped, state: next };
}

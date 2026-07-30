/** A deliberately small controllable clock for timeout-free state-transition tests. */
export function createFakeClock(start = 0) {
  let now = start;
  let sequence = 0;
  const timers = new Map();

  const runDue = () => {
    for (;;) {
      const due = [...timers.values()]
        .filter(timer => timer.at <= now)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) return;
      timers.delete(due.id);
      due.callback();
      if (due.interval !== undefined) {
        due.at += due.interval;
        timers.set(due.id, due);
      }
    }
  };

  const schedule = (callback, delay, interval) => {
    const id = ++sequence;
    timers.set(id, { id, callback, at: now + Math.max(0, delay), interval });
    return id;
  };
  return {
    now: () => now,
    date: () => new Date(now),
    setTimeout: (callback, delay = 0) => schedule(callback, delay),
    setInterval: (callback, delay = 0) => schedule(callback, delay, Math.max(1, delay)),
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error("Fake clock advance must be a non-negative finite number.");
      now += ms;
      runDue();
    },
    pending: () => timers.size,
  };
}

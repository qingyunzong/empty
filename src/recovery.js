'use strict';
const { applyOps } = require('./core.js');

// Resume after a crash:
//   1. discard stale *.tmp files (their rename never happened)
//   2. replay scan.log from the cursor into open sessions (idempotent by scanId)
//   3. finalize closes whose ledger commit survived (session file left behind)
//   4. drain pending ops that may have become applicable
function resume(store) {
  store.cleanTmp();
  store.requireInit();
  const state = store.loadState();
  let cursor = store.loadCursor();
  let replayed = 0;
  for (const { ev, endOffset } of store.readEventsFrom(cursor.offset)) {
    const sess = store.loadSession(ev.session);
    if (sess && sess.status === 'open' && !sess.ops.some((o) => o.scanId === ev.scanId)) {
      sess.ops.push({ scanId: ev.scanId, type: ev.type, bin: ev.bin, item: ev.item, delta: ev.delta });
      store.saveSession(sess);
      replayed++;
    }
    cursor = { offset: endOffset };
    store.saveCursor(cursor);
  }
  let finalized = 0;
  for (const id of state.closedSessions) {
    if (store.loadSession(id)) {
      store.deleteSession(id);
      finalized++;
    }
  }
  let drained = 0;
  if (state.pending.length > 0) {
    const res = applyOps(state.inventory, state.pending);
    drained = res.applied.length;
    state.ops.push(...res.applied);
    state.pending = res.pending;
    if (drained > 0) store.saveState(state);
  }
  return { replayed, finalized, drained, pending: state.pending.length };
}

module.exports = { resume };

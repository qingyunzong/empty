'use strict';

// One output line per log entry: every judgement is rendered together with
// the remaining budget and the Merkle root of the append-only log.
function formatEntry(e) {
  if (e.auto && e.kind === 'expire') {
    return `#- tick=${e.tick} event=expire reqId=${e.reqId} member=${e.member}` +
      ` released=${e.released} auto=true remaining=${e.remainingBudget} merkle=${e.root}`;
  }
  let line = `#${e.n} tick=${e.tick} seq=${e.seq} type=${e.kind} member=${e.member}` +
    ` reqId=${e.reqId} amount=${e.amount} status=${e.status}`;
  if (e.kind === 'reserve') line += ` granted=${e.granted}`;
  if (e.kind === 'commit' && e.committed != null) line += ` committed=${e.committed}`;
  if ((e.kind === 'release' || e.kind === 'expire') && e.released != null) line += ` released=${e.released}`;
  if (e.reason) line += ` reason=${e.reason}`;
  if (e.dup) line += ` dup=true`;
  if (e.noop) line += ` noop=true`;
  line += ` remaining=${e.remainingBudget} merkle=${e.root}`;
  return line;
}

module.exports = { formatEntry };

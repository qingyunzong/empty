import { VM } from './vm.js';

// Fold an event stream through a fresh VM.
// Options:
//   at: stop before the first event with seq > at (prefix query)
//   collect: also return a snapshot after every applied event
export function fold(events, { at = null, collect = false } = {}) {
  const vm = new VM();
  const prefixes = [];
  for (const evt of events) {
    if (at !== null && evt.seq > at) break;
    const r = vm.applyEvent(evt);
    if (!r.ok) return { ok: false, error: { code: r.code, message: r.message }, seq: evt.seq };
    if (collect) prefixes.push(vm.snapshot());
  }
  return { ok: true, state: vm.snapshot(), prefixes };
}

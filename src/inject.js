// Fault injection: drop / dup / delay. Every injection is itself appended to
// the log (kind: 'injection') so the fault campaign is auditable and replayable.
export function injectFaults(log, events, faults) {
  let out = events.slice();
  let clock = events.reduce((m, e) => Math.max(m, e.ts), 0);
  let dupCount = 0;
  for (const fault of faults) {
    const target = out.find((e) => e.id === fault.id);
    if (!target) throw new Error(`inject: unknown event id "${fault.id}"`);
    clock += 1;
    log.append({
      kind: 'injection',
      ts: clock,
      src: 'plc',
      fault: { ...fault },
    });
    if (fault.type === 'drop') {
      out = out.filter((e) => e.id !== fault.id);
    } else if (fault.type === 'dup') {
      dupCount += 1;
      out.push({ ...target, id: `${target.id}#dup${dupCount}` });
    } else if (fault.type === 'delay') {
      out = out.map((e) =>
        e.id === fault.id ? { ...e, ts: e.ts + fault.delta } : e,
      );
    } else {
      throw new Error(`inject: unknown fault type "${fault.type}"`);
    }
  }
  return out;
}

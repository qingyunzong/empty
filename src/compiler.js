export const OP = {
  BLOCK: 1,
  ADDRANGE: 2,
  CHKBLOCK: 3,
  CHKPEAK: 4,
  HALT: 5,
};

export function compileSite(site) {
  const staticCode = site.maintenanceRanges.map(([s, e]) => [OP.BLOCK, s, e]);
  const tasks = site.tasks.map((t) => ({ id: t.id, watts: t.watts, durationSlots: t.durationSlots }));
  const checks = [[OP.CHKBLOCK]];
  if (site.peakLimitW != null) checks.push([OP.CHKPEAK, site.peakLimitW]);
  checks.push([OP.HALT]);
  return { slots: site.slots, staticCode, tasks, checks };
}

export function link(program, runLists) {
  const code = program.staticCode.slice();
  for (let i = 0; i < program.tasks.length; i += 1) {
    const t = program.tasks[i];
    for (const [start, end] of runLists[i]) code.push([OP.ADDRANGE, start, end, t.watts]);
  }
  for (const ins of program.checks) code.push(ins);
  return code;
}

export function disassemble(code) {
  const names = { 1: 'BLOCK', 2: 'ADDRANGE', 3: 'CHKBLOCK', 4: 'CHKPEAK', 5: 'HALT' };
  return code.map((ins) => `${names[ins[0]] ?? '???'} ${ins.slice(1).join(' ')}`.trim()).join('\n');
}

// Independent feasibility checker. Deliberately shares no code with the
// scheduler so tests can cross-validate results.
export function checkSchedule(config, instructions, assignments) {
  const violations = [];
  const byId = new Map(instructions.map((i) => [i.id, i]));
  const slotLoad = new Map();
  const instUsage = new Map();

  for (const [id, slot] of assignments) {
    const instr = byId.get(id);
    if (!instr) {
      violations.push(`unknown instruction ${id} assigned`);
      continue;
    }
    if (!Number.isInteger(slot) || slot < instr.arrivalSlot || slot > instr.deadlineSlot) {
      violations.push(`${id}: slot ${slot} outside [arrival=${instr.arrivalSlot}, deadline=${instr.deadlineSlot}]`);
    }
    slotLoad.set(slot, (slotLoad.get(slot) ?? 0) + 1);
    instUsage.set(instr.institution, (instUsage.get(instr.institution) ?? 0) + 1);
  }
  for (const [slot, load] of slotLoad) {
    if (load > config.capacityPerSlot) {
      violations.push(`slot ${slot} overloaded: ${load} > ${config.capacityPerSlot}`);
    }
  }
  for (const [inst, used] of instUsage) {
    const quota = config.quotas instanceof Map
      ? (config.quotas.has(inst) ? config.quotas.get(inst) : Infinity)
      : (config.quotas && inst in config.quotas ? config.quotas[inst] : Infinity);
    if (used > quota) {
      violations.push(`institution ${inst} over quota: ${used} > ${quota}`);
    }
  }
  for (const [id, slot] of assignments) {
    const instr = byId.get(id);
    if (!instr) continue;
    for (const dep of instr.dependencies ?? []) {
      const depSlot = assignments.get(dep);
      if (depSlot === undefined) {
        violations.push(`${id}: dependency ${dep} is not scheduled`);
      } else if (depSlot >= slot) {
        violations.push(`${id}: dependency ${dep} (slot ${depSlot}) not before slot ${slot}`);
      }
    }
  }
  return violations;
}

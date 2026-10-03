import { run } from "./interpreter.js";

function firstIllegalAutoStart(events) {
  const { violations } = run(events);
  return violations.find((v) => v.type === "illegal_auto_start") ?? null;
}

export function minimalCounterexample(events) {
  for (let k = 1; k <= events.length; k += 1) {
    const prefix = events.slice(0, k);
    const violation = firstIllegalAutoStart(prefix);
    if (violation) {
      return { found: true, length: k, prefix, violation, reduced: reduceCounterexample(prefix) };
    }
  }
  return { found: false };
}

export function reduceCounterexample(prefix) {
  let current = prefix.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length - 1; i += 1) {
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (firstIllegalAutoStart(candidate)) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  return current;
}

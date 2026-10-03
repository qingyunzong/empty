import { run } from "./interpreter.js";
import { Interpreter } from "./interpreter.js";
import { referenceRun, ReferenceInterpreter } from "./reference.js";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function* enumerate(factories, maxLen) {
  const current = [];
  function* dfs() {
    if (current.length > 0) yield current;
    if (current.length === maxLen) return;
    for (const make of factories) {
      current.push(make(current.length));
      yield* dfs();
      current.pop();
    }
  }
  yield* dfs();
}

function joinCanon(canonList, records) {
  if (records.length === 0) return canonList;
  const encoded = records.map(canonical).join(",");
  return canonList === "" ? encoded : `${canonList},${encoded}`;
}

export function crossCheck(factories, maxLen, { limit = 5 } = {}) {
  let checked = 0;
  const mismatches = [];
  const sequence = [];

  function dfs(interp, canonTI, canonVI, ref, canonTR, canonVR) {
    if (sequence.length > 0) {
      checked += 1;
      if (canonTI !== canonTR || canonVI !== canonVR) {
        const a = run(sequence);
        const b = referenceRun(sequence);
        mismatches.push({
          sequence: sequence.map((e) => ({ ...e })),
          interpreter: JSON.parse(canonical({ transitions: a.transitions, violations: a.violations })),
          reference: JSON.parse(canonical({ transitions: b.transitions, violations: b.violations })),
        });
        return mismatches.length < limit;
      }
    }
    if (sequence.length === maxLen) return true;
    for (const make of factories) {
      const event = make(sequence.length);
      sequence.push(event);

      const nextInterp = interp.clone();
      nextInterp.applyGroup([event]);
      const nextRef = ref.clone();
      nextRef.applyGroup([event]);

      const keepGoing = dfs(
        nextInterp,
        joinCanon(canonTI, nextInterp.transitions),
        joinCanon(canonVI, nextInterp.violations),
        nextRef,
        joinCanon(canonTR, nextRef.transitions),
        joinCanon(canonVR, nextRef.violations),
      );
      sequence.pop();
      if (!keepGoing) return false;
    }
    return true;
  }

  dfs(new Interpreter(), "", "", new ReferenceInterpreter(), "", "");
  return { checked, mismatches };
}

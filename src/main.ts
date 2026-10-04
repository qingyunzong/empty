/** Demo: slice one output of an example trace, delete the rest, replay. */

import { describeEvent, replay, TraceEvent } from "./trace";
import { dynamicSlice } from "./slice";
import { checkSlice, projectMask } from "./verify";
import { analyze } from "./trace";

// A small "account" computation logged as read/write state events.
const trace: TraceEvent[] = [
  { op: "const", out: "balance", value: 1000 }, //  0
  { op: "const", out: "rate", value: 5 }, //        1
  { op: "const", out: "vip", value: 1 }, //         2
  { op: "const", out: "log", value: 0 }, //          3  (noise)
  { op: "compute", out: "interest", fn: "mul", args: ["balance", "rate"] }, // 4
  { op: "compute", out: "log", fn: "add", args: ["log", "rate"] }, // 5 (noise)
  { op: "const", out: "interest", value: 0 }, //     6  overwritten, dead
  { op: "if", cond: "vip" }, //                      7
  { op: "compute", out: "interest", fn: "mul", args: ["balance", "rate"] }, // 8
  { op: "else" }, //                                 9
  { op: "compute", out: "interest", fn: "sub", args: ["balance", "rate"] }, // 10 (not taken)
  { op: "end" }, //                                  11
  { op: "compute", out: "total", fn: "add", args: ["balance", "interest"] }, // 12
  { op: "output", arg: "log" }, //                   13 (other output)
  { op: "output", arg: "total" }, //                 14 (target)
];

const target = 14;
const structure = analyze(trace);
const full = replay(trace);
console.log("== full trace ==");
trace.forEach((ev, i) => console.log("  " + describeEvent(i, ev)));
console.log(`full replay: output(#13)=${full.outputs.get(13)} output(#14)=${full.outputs.get(target)}`);

const slice = dynamicSlice(trace, target);
console.log(`\n== minimal dynamic slice for output #${target} (${slice.size} events) ==`);
for (const i of [...slice].sort((a, b) => a - b)) {
  console.log("  " + describeEvent(i, trace[i]));
}

const check = checkSlice(trace, target, slice);
const kept = projectMask(trace, structure, slice);
console.log("\n== delete non-slice events and replay ==");
console.log(`deleted events: ${trace.length - kept.size} of ${trace.length}`);
console.log(`target output after deletion: ${check.slicedValue} (original ${check.originalValue})`);
console.log(`reproduces: ${check.reproduces}`);
console.log(`exhaustive minimality: ${check.minimal} (${check.checked} control-closed proper subsets replayed)`);

import { Runtime, type Snapshot } from "../src/index.js";
import { standardProgram } from "../test/program.js";

const seed = Number(process.argv[2] ?? 42);

const rt = new Runtime({ seed });
standardProgram(rt);
const trace = await rt.run();

console.log(`seed=${seed} events=${trace.length} steps=${rt.snapshots.length}`);
console.log(" seq  kind      task        detail              clock  candidates");
for (const e of trace) {
  console.log(
    `${String(e.seq).padStart(4)}  ${e.kind.padEnd(9)} ${e.task.padEnd(11)} ` +
      `${e.detail.padEnd(19)} ${String(e.clock).padStart(5)}  ${e.candidates.join(" ")}`,
  );
}

const replay = new Runtime({ seed, replay: trace });
standardProgram(replay);
await replay.run();
console.log("replay: OK (event sets matched)");

const segmented = new Runtime({ seed });
standardProgram(segmented);
const half = Math.floor(rt.snapshots.length / 2);
while (segmented.snapshots.length < half) await segmented.step();
const snap = JSON.parse(JSON.stringify(segmented.snapshot())) as Snapshot;
segmented.restore(snap);
const segTrace = await segmented.run();
const identical = JSON.stringify(segTrace) === JSON.stringify(trace);
console.log(
  `segments: restored at step ${half} (rngState=${snap.rngState}, digest=${snap.digest}); ` +
    `trace identical to full run: ${identical}`,
);

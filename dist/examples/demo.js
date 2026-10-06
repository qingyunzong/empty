"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("../src/index");
const map = new index_1.TempoMap();
map.setTempo(0, 120); // 500 ms/beat
map.setTempo(4, "179.5"); // tempo change at beat 4
map.setTempo("15/2", 90); // and at beat 7.5
map.addEvent("kick-1", 1, 0);
map.addEvent("snare-1", 2, 2);
map.addEvent("lead-a", 0, 2);
map.addEvent("kick-2", 1, "15/2");
map.addEvent("pad", 0, "15/2");
console.log("== timeline (beat, track, id) ==");
for (const e of map.timeline()) {
    console.log(`beat=${e.beat} track=${e.track} id=${e.id} ms=${e.ms} (~${e.ms.toNumber().toFixed(3)}ms)`);
}
map.undo(); // restore tempo before the 90bpm change
console.log("\nafter undo, tempo points:");
for (const p of map.tempoPoints)
    console.log(`beat=${p.beat} bpm=${p.bpm}`);
const cert = (0, index_1.buildCertificate)(map);
console.log("\n== certificate ==");
console.log(JSON.stringify(cert, null, 2));

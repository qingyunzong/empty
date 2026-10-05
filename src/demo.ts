import { Rational } from "./rational";
import { TempoMap } from "./tempo-map";
import { Score } from "./score";
import { generateCertificate, verifyCertificate, defaultSampleBeats } from "./certificate";
import { compareWithIntegration } from "./integration";

const score = new Score(TempoMap.fromBpm(Rational.of(120))); // 500 ms/beat

score.addEvent({ id: "kick-1", track: 2, beat: Rational.of(0), kind: "note" });
score.addEvent({ id: "lead-1", track: 1, beat: Rational.of(0), kind: "note" });
score.addEvent({ id: "snare-1", track: 2, beat: Rational.of(1), kind: "note" });
score.addEvent({ id: "lead-2", track: 1, beat: Rational.of(3, 2), kind: "note" });
score.addEvent({ id: "bass-1", track: 3, beat: Rational.of(3, 2), kind: "note" });
score.addEvent({ id: "crash", track: 2, beat: Rational.of(4), kind: "note" });

// Tempo changes: 90 bpm from beat 2, then 150 bpm from beat 3.
score.setTempo(Rational.of(2), Rational.of(60000).div(Rational.of(90)));
score.setTempo(Rational.of(3), Rational.of(60000).div(Rational.of(150)));

console.log("== timeline (beat -> exact ms, ordered by beat/track/id) ==");
for (const entry of score.timeline()) {
  console.log(
    `beat ${entry.beat.toString().padEnd(5)} track ${entry.event.track} ` +
      `${entry.event.id.padEnd(8)} ms = ${entry.ms.toString()} (~${entry.ms.toNumber().toFixed(3)})`,
  );
}

console.log("\n== undo last tempo change (150 bpm @ beat 3) ==");
score.undoTempo();
for (const entry of score.timeline()) {
  console.log(`beat ${entry.beat.toString().padEnd(5)} ${entry.event.id.padEnd(8)} ms = ${entry.ms.toString()}`);
}
// redo for the certificate
score.setTempo(Rational.of(3), Rational.of(60000).div(Rational.of(150)));

const cert = generateCertificate(score.tempoMap);
console.log("\n== bidirectional mapping certificate ==");
console.log(JSON.stringify(cert, null, 2));
const verification = verifyCertificate(score.tempoMap, cert);
console.log("certificate verifies:", verification.ok);

console.log("\n== exact rational ms vs direct numerical integration ==");
for (const row of compareWithIntegration(score.tempoMap, defaultSampleBeats(score.tempoMap))) {
  console.log(
    `beat ${row.beat.padEnd(5)} exact ${row.exactMs.toFixed(6)} ms ` +
      `integrated ${row.integratedMs.toFixed(6)} ms relErr ${row.relError.toExponential(2)}`,
  );
}

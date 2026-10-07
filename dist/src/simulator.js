"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSimulation = runSimulation;
const detector_1 = require("./detector");
function runSimulation(cfg, rand) {
    const detector = new detector_1.Detector(cfg);
    const events = [];
    const acks = [];
    let nodeHeartbeat = 0;
    for (let t = 0; t <= cfg.ticks; t += cfg.probeInterval) {
        const generation = t / cfg.probeInterval + 1;
        events.push({ tick: t, kind: "probe", generation });
        if (rand() >= cfg.dropRate) {
            nodeHeartbeat += 1;
            const delay = 1 + Math.floor(rand() * (cfg.maxDelay + 1));
            const ack = { tick: t + delay, generation, heartbeat: nodeHeartbeat };
            acks.push(ack);
            events.push({ tick: ack.tick, kind: "ack", generation, heartbeat: nodeHeartbeat });
        }
    }
    acks.sort((a, b) => a.tick - b.tick || a.heartbeat - b.heartbeat);
    const timeline = [];
    let nextAck = 0;
    for (let t = 0; t <= cfg.ticks; t++) {
        if (t % cfg.probeInterval === 0) {
            detector.startProbe(t);
        }
        while (nextAck < acks.length && acks[nextAck].tick === t) {
            detector.receiveAck(t, acks[nextAck]);
            nextAck += 1;
        }
        detector.evaluateTimeouts(t);
        timeline.push({
            tick: t,
            status: detector.status,
            heartbeat: detector.heartbeat,
            generation: detector.generation,
        });
    }
    return { detector, timeline, events };
}

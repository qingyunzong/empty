"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.replayReference = replayReference;
function replayReference(cfg, events) {
    let status = "ALIVE";
    let heartbeat = 0;
    let generation = 0;
    let generationStart = 0;
    let lastValidAck = 0;
    let deadline = Number.POSITIVE_INFINITY;
    const byTick = new Map();
    for (const e of events) {
        const list = byTick.get(e.tick);
        if (list)
            list.push(e);
        else
            byTick.set(e.tick, [e]);
    }
    const timeline = [];
    for (let t = 0; t <= cfg.ticks; t++) {
        const todays = byTick.get(t) ?? [];
        for (const e of todays) {
            if (e.kind === "probe") {
                generation = e.generation;
                generationStart = t;
            }
        }
        for (const e of todays) {
            if (e.kind === "ack" &&
                status !== "DEAD" &&
                e.generation === generation &&
                e.heartbeat !== undefined &&
                e.heartbeat > heartbeat) {
                heartbeat = e.heartbeat;
                lastValidAck = t;
                status = "ALIVE";
                deadline = Number.POSITIVE_INFINITY;
            }
        }
        if (status === "ALIVE" && t - lastValidAck >= cfg.suspectTimeout) {
            status = "SUSPECT";
            deadline = t + cfg.suspicionTimeout;
        }
        else if (status === "SUSPECT" && t >= deadline) {
            status = "DEAD";
        }
        timeline.push({ tick: t, status, heartbeat, generation });
    }
    return timeline;
}

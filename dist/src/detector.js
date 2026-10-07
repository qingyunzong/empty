"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Detector = void 0;
class Detector {
    config;
    status = "ALIVE";
    heartbeat = 0;
    generation = 0;
    generationStartTick = 0;
    lastValidAckTick = 0;
    suspicionDeadline = null;
    transitions = [];
    ignoredAcks = [];
    constructor(config) {
        this.config = config;
    }
    startProbe(tick) {
        this.generation += 1;
        this.generationStartTick = tick;
    }
    receiveAck(tick, ack) {
        if (this.status === "DEAD") {
            this.ignoredAcks.push({
                tick,
                ack,
                reason: "node already DEAD; detector no longer accepts acks",
            });
            return false;
        }
        if (ack.generation !== this.generation) {
            this.ignoredAcks.push({
                tick,
                ack,
                reason: `stale generation ${ack.generation} (current ${this.generation}); old replies cannot clear suspicion`,
            });
            return false;
        }
        if (ack.heartbeat <= this.heartbeat) {
            this.ignoredAcks.push({
                tick,
                ack,
                reason: `old heartbeat ${ack.heartbeat} <= applied ${this.heartbeat}; cannot refresh`,
            });
            return false;
        }
        this.heartbeat = ack.heartbeat;
        this.lastValidAckTick = tick;
        this.suspicionDeadline = null;
        if (this.status !== "ALIVE") {
            this.transition(tick, "ALIVE", `valid ack (generation ${ack.generation}, heartbeat ${ack.heartbeat}) cleared ${this.status.toLowerCase()}`);
        }
        return true;
    }
    evaluateTimeouts(tick) {
        if (this.status === "ALIVE" &&
            tick - this.lastValidAckTick >= this.config.suspectTimeout) {
            this.suspicionDeadline = tick + this.config.suspicionTimeout;
            this.transition(tick, "SUSPECT", `no valid ack for ${this.config.suspectTimeout} ticks (last valid ack at tick ${this.lastValidAckTick}); suspicion deadline ${this.suspicionDeadline}`);
            return;
        }
        if (this.status === "SUSPECT" &&
            this.suspicionDeadline !== null &&
            tick >= this.suspicionDeadline) {
            this.transition(tick, "DEAD", `suspicion deadline ${this.suspicionDeadline} reached without a valid ack`);
        }
    }
    transition(tick, to, reason) {
        const from = this.status;
        this.status = to;
        this.transitions.push({ tick, from, to, reason });
    }
}
exports.Detector = Detector;

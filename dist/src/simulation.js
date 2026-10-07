"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Simulation = void 0;
/**
 * 仿真门面：把监控器与模拟网络接起来。
 * advanceTo(now) 先取回该时刻到期（可能已重排）的回包交给监控器，
 * 监控器内部保证同刻有效回包先于超时判定。
 */
class Simulation {
    monitor;
    network;
    constructor(monitor, network) {
        this.monitor = monitor;
        this.network = network;
    }
    probe(nodeId, now) {
        const probe = this.monitor.issueProbe(nodeId, now);
        this.network.send(probe, now);
        return probe;
    }
    advanceTo(now) {
        this.monitor.advance(now, this.network.deliverDue(now));
    }
}
exports.Simulation = Simulation;

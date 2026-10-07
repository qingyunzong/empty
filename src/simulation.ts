import { ProbeMonitor } from "./monitor";
import { SimulatedNetwork } from "./network";
import { Probe } from "./types";

/**
 * 仿真门面：把监控器与模拟网络接起来。
 * advanceTo(now) 先取回该时刻到期（可能已重排）的回包交给监控器，
 * 监控器内部保证同刻有效回包先于超时判定。
 */
export class Simulation {
  constructor(
    readonly monitor: ProbeMonitor,
    readonly network: SimulatedNetwork,
  ) {}

  probe(nodeId: string, now: number): Probe {
    const probe = this.monitor.issueProbe(nodeId, now);
    this.network.send(probe, now);
    return probe;
  }

  advanceTo(now: number): void {
    this.monitor.advance(now, this.network.deliverDue(now));
  }
}

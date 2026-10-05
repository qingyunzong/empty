import type { EnergyEvent, SimConfig, TickSnapshot } from "./types.js";

export interface VehicleLedger {
  vehicleId: string;
  initialBattery: number;
  charged: number;
  driveConsumed: number;
  auxConsumed: number;
  finalBattery: number;
  /** initial + charged - drive - aux === final */
  balanced: boolean;
}

/**
 * Rebuild the per-vehicle energy ledger purely from the event log and the
 * recorded final batteries.
 */
export function computeLedger(
  config: SimConfig,
  events: readonly EnergyEvent[],
  history: readonly TickSnapshot[],
): VehicleLedger[] {
  const last = history[history.length - 1];
  const finalById = new Map<string, number>();
  if (last) {
    for (const v of last.vehicles) finalById.set(v.id, v.battery);
  }
  return config.vehicles.map((spec) => {
    let charged = 0;
    let drive = 0;
    let aux = 0;
    for (const e of events) {
      if (e.vehicleId !== spec.id) continue;
      if (e.type === "charge") charged += e.amount;
      else if (e.type === "drive") drive += e.amount;
      else aux += e.amount;
    }
    const finalBattery = finalById.get(spec.id) ?? spec.initialBattery;
    return {
      vehicleId: spec.id,
      initialBattery: spec.initialBattery,
      charged,
      driveConsumed: drive,
      auxConsumed: aux,
      finalBattery,
      balanced: spec.initialBattery + charged - drive - aux === finalBattery,
    };
  });
}

/**
 * Replay the event log from the initial batteries and reconstruct the battery
 * of every vehicle at the start of each tick. This is the "replay" half of
 * the snapshot-replay audit.
 */
export function replayBatteries(
  config: SimConfig,
  events: readonly EnergyEvent[],
  tickCount: number,
): Map<string, number>[] {
  const batteries = new Map<string, number>();
  for (const v of config.vehicles) batteries.set(v.id, v.initialBattery);
  const byTick = new Map<number, EnergyEvent[]>();
  for (const e of events) {
    const list = byTick.get(e.tick) ?? [];
    list.push(e);
    byTick.set(e.tick, list);
  }
  const frames: Map<string, number>[] = [new Map(batteries)];
  for (let t = 0; t < tickCount; t += 1) {
    for (const e of byTick.get(t) ?? []) {
      const current = batteries.get(e.vehicleId);
      if (current === undefined) continue;
      batteries.set(
        e.vehicleId,
        e.type === "charge" ? current + e.amount : current - e.amount,
      );
    }
    frames.push(new Map(batteries));
  }
  return frames;
}

export interface AuditResult {
  ok: boolean;
  failures: string[];
}

/**
 * Full audit: replay the event log, check it reproduces every recorded
 * snapshot exactly, check the energy ledger balances per vehicle, and check
 * no battery ever leaves [0, capacity].
 */
export function auditReplay(
  config: SimConfig,
  events: readonly EnergyEvent[],
  history: readonly TickSnapshot[],
): AuditResult {
  const failures: string[] = [];
  const tickCount = Math.max(0, history.length - 1);
  const frames = replayBatteries(config, events, tickCount);

  for (let t = 0; t < history.length; t += 1) {
    const snap = history[t];
    const frame = frames[t];
    if (!snap || !frame) continue;
    for (const v of snap.vehicles) {
      const replayed = frame.get(v.id);
      if (replayed !== v.battery) {
        failures.push(
          `tick ${snap.tick} vehicle ${v.id}: snapshot battery ${v.battery} != replayed ${replayed}`,
        );
      }
    }
  }

  for (const ledger of computeLedger(config, events, history)) {
    if (!ledger.balanced) {
      failures.push(
        `vehicle ${ledger.vehicleId}: ledger unbalanced (initial ${ledger.initialBattery} + charged ${ledger.charged} - drive ${ledger.driveConsumed} - aux ${ledger.auxConsumed} != final ${ledger.finalBattery})`,
      );
    }
  }

  const capacityById = new Map(config.vehicles.map((v) => [v.id, v.batteryCapacity]));
  for (const snap of history) {
    for (const v of snap.vehicles) {
      const capacity = capacityById.get(v.id) ?? 0;
      if (v.battery < 0) {
        failures.push(`tick ${snap.tick} vehicle ${v.id}: negative battery ${v.battery}`);
      }
      if (v.battery > capacity) {
        failures.push(
          `tick ${snap.tick} vehicle ${v.id}: battery ${v.battery} exceeds capacity ${capacity}`,
        );
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

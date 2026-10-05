import type { SimResult, VerificationReport } from "./types.js";

export function verifyReplay(result: SimResult): VerificationReport {
  const errors: string[] = [];
  const { config, snapshots, ledger } = result;

  for (let i = 0; i < snapshots.length; i += 1) {
    const snapshot = snapshots[i];
    if (snapshot === undefined || snapshot.tick !== i) {
      errors.push(`snapshot ${i}: missing or out-of-order tick`);
    }
  }

  const specById = new Map(config.vehicles.map((spec) => [spec.id, spec]));

  for (const spec of config.vehicles) {
    const entries = ledger.filter((entry) => entry.vehicleId === spec.id);
    let energy = spec.initialEnergy;
    let cursor = 0;
    for (let tick = 0; tick < snapshots.length; tick += 1) {
      const snapshot = snapshots[tick];
      const vehicleSnap = snapshot?.vehicles.find((item) => item.id === spec.id);
      if (vehicleSnap === undefined) {
        errors.push(`vehicle ${spec.id}: missing in snapshot tick ${tick}`);
        continue;
      }
      const tickStart = energy;
      while (cursor < entries.length && (entries[cursor] as { tick: number }).tick === tick) {
        const entry = entries[cursor] as { before: number; after: number; delta: number; kind: string };
        if (entry.before !== energy) {
          errors.push(
            `vehicle ${spec.id} tick ${tick} ${entry.kind}: ledger before=${entry.before} but replayed energy=${energy}`,
          );
        }
        if (entry.after !== entry.before + entry.delta) {
          errors.push(
            `vehicle ${spec.id} tick ${tick} ${entry.kind}: inconsistent entry ${entry.before}+(${entry.delta})!=${entry.after}`,
          );
        }
        if (entry.after < 0) {
          errors.push(`vehicle ${spec.id} tick ${tick} ${entry.kind}: negative energy ${entry.after}`);
        }
        energy = entry.after;
        cursor += 1;
      }
      if (energy !== tickStart + entriesDelta(entries, tick)) {
        errors.push(`vehicle ${spec.id} tick ${tick}: energy accounting mismatch`);
      }
      if (vehicleSnap.energy !== energy) {
        errors.push(
          `vehicle ${spec.id} tick ${tick}: snapshot energy=${vehicleSnap.energy} but replayed energy=${energy}`,
        );
      }
      if (energy < 0) {
        errors.push(`vehicle ${spec.id} tick ${tick}: negative energy ${energy}`);
      }
      if (energy > spec.batteryCapacity) {
        errors.push(`vehicle ${spec.id} tick ${tick}: energy ${energy} exceeds capacity ${spec.batteryCapacity}`);
      }
      if (vehicleSnap.energy < 0) {
        errors.push(`vehicle ${spec.id} tick ${tick}: snapshot has negative energy ${vehicleSnap.energy}`);
      }
    }
    if (cursor !== entries.length) {
      const entry = entries[cursor];
      errors.push(`vehicle ${spec.id}: ledger entry beyond snapshots (tick ${entry?.tick})`);
    }
    const totalDelta = entries.reduce((sum, entry) => sum + entry.delta, 0);
    const lastSnap = snapshots[snapshots.length - 1]?.vehicles.find((item) => item.id === spec.id);
    if (lastSnap !== undefined && spec.initialEnergy + totalDelta !== lastSnap.energy) {
      errors.push(
        `vehicle ${spec.id}: ledger total ${spec.initialEnergy}+(${totalDelta}) != final snapshot energy ${lastSnap.energy}`,
      );
    }
  }

  const ledgerVehicles = new Set(ledger.map((entry) => entry.vehicleId));
  for (const id of ledgerVehicles) {
    if (!specById.has(id)) {
      errors.push(`ledger references unknown vehicle ${id}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function entriesDelta(entries: Array<{ tick: number; delta: number }>, tick: number): number {
  let sum = 0;
  for (const entry of entries) {
    if (entry.tick === tick) {
      sum += entry.delta;
    }
  }
  return sum;
}

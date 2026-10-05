import type {
  EdgeSpec,
  LedgerEntry,
  SimConfig,
  SimResult,
  StationSnapshot,
  TickSnapshot,
  VehicleSnapshot,
  VehicleStatus,
} from "./types.js";

interface VehicleRuntime {
  id: string;
  path: string[];
  nodeIndex: number;
  energy: number;
  batteryCapacity: number;
  chargeStops: ReadonlySet<string>;
  auxDrainPerTick: number;
  queued: boolean;
}

interface StationRuntime {
  node: string;
  capacity: number;
  chargePerTick: number;
  windows: Array<[number, number]>;
  queue: string[];
  granted: string[];
}

function isOpen(windows: Array<[number, number]>, tick: number): boolean {
  return windows.some(([start, end]) => tick >= start && tick < end);
}

function validateConfig(config: SimConfig): void {
  if (!Number.isInteger(config.maxTicks) || config.maxTicks <= 0) {
    throw new Error("maxTicks must be a positive integer");
  }
  const edgeKeys = new Set<string>();
  for (const edge of config.edges) {
    if (!Number.isInteger(edge.energy) || edge.energy < 0) {
      throw new Error(`edge ${edge.from}->${edge.to} energy must be a non-negative integer`);
    }
    edgeKeys.add(`${edge.from}->${edge.to}`);
  }
  const nodes = new Set<string>();
  for (const edge of config.edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
  }
  const vehicleIds = new Set<string>();
  for (const vehicle of config.vehicles) {
    if (vehicleIds.has(vehicle.id)) {
      throw new Error(`duplicate vehicle id ${vehicle.id}`);
    }
    vehicleIds.add(vehicle.id);
    if (vehicle.path.length < 1) {
      throw new Error(`vehicle ${vehicle.id} path must not be empty`);
    }
    for (const node of vehicle.path) {
      if (!nodes.has(node)) {
        throw new Error(`vehicle ${vehicle.id} path node ${node} is not in the network`);
      }
    }
    for (let i = 0; i + 1 < vehicle.path.length; i += 1) {
      const key = `${vehicle.path[i]}->${vehicle.path[i + 1]}`;
      if (!edgeKeys.has(key)) {
        throw new Error(`vehicle ${vehicle.id} path edge ${key} is not in the network`);
      }
    }
    for (const value of [vehicle.initialEnergy, vehicle.batteryCapacity]) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`vehicle ${vehicle.id} energy values must be non-negative integers`);
      }
    }
    if (vehicle.initialEnergy > vehicle.batteryCapacity) {
      throw new Error(`vehicle ${vehicle.id} initialEnergy exceeds batteryCapacity`);
    }
  }
  const stationNodes = new Set<string>();
  for (const station of config.stations) {
    if (stationNodes.has(station.node)) {
      throw new Error(`duplicate station at node ${station.node}`);
    }
    stationNodes.add(station.node);
    if (!nodes.has(station.node)) {
      throw new Error(`station node ${station.node} is not in the network`);
    }
    if (!Number.isInteger(station.capacity) || station.capacity <= 0) {
      throw new Error(`station ${station.node} capacity must be a positive integer`);
    }
    if (!Number.isInteger(station.chargePerTick) || station.chargePerTick <= 0) {
      throw new Error(`station ${station.node} chargePerTick must be a positive integer`);
    }
    for (const [start, end] of station.windows) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
        throw new Error(`station ${station.node} has invalid window [${start}, ${end})`);
      }
    }
  }
  for (const vehicle of config.vehicles) {
    for (const stop of vehicle.chargeStops ?? []) {
      if (!stationNodes.has(stop)) {
        throw new Error(`vehicle ${vehicle.id} charge stop ${stop} has no station`);
      }
      if (!vehicle.path.includes(stop)) {
        throw new Error(`vehicle ${vehicle.id} charge stop ${stop} is not on its path`);
      }
    }
  }
}

export function simulate(config: SimConfig): SimResult {
  validateConfig(config);

  const edgeByKey = new Map<string, EdgeSpec>();
  for (const edge of config.edges) {
    edgeByKey.set(`${edge.from}->${edge.to}`, edge);
  }

  const vehicles: VehicleRuntime[] = config.vehicles.map((spec) => ({
    id: spec.id,
    path: spec.path,
    nodeIndex: 0,
    energy: spec.initialEnergy,
    batteryCapacity: spec.batteryCapacity,
    chargeStops: new Set(spec.chargeStops ?? []),
    auxDrainPerTick: spec.auxDrainPerTick ?? 0,
    queued: false,
  }));
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));

  const stations: StationRuntime[] = config.stations.map((spec) => ({
    node: spec.node,
    capacity: spec.capacity,
    chargePerTick: spec.chargePerTick,
    windows: spec.windows,
    queue: [],
    granted: [],
  }));
  const stationByNode = new Map(stations.map((station) => [station.node, station]));

  const ledger: LedgerEntry[] = [];
  const snapshots: TickSnapshot[] = [];

  for (let tick = 0; tick < config.maxTicks; tick += 1) {
    for (const station of stations) {
      station.granted = [];
    }

    for (const vehicle of vehicles) {
      if (vehicle.queued || vehicle.nodeIndex + 1 >= vehicle.path.length) {
        continue;
      }
      const from = vehicle.path[vehicle.nodeIndex] as string;
      const to = vehicle.path[vehicle.nodeIndex + 1] as string;
      const edge = edgeByKey.get(`${from}->${to}`) as EdgeSpec;
      if (vehicle.energy < edge.energy) {
        continue;
      }
      const before = vehicle.energy;
      vehicle.energy -= edge.energy;
      vehicle.nodeIndex += 1;
      ledger.push({ tick, vehicleId: vehicle.id, kind: "move", delta: -edge.energy, before, after: vehicle.energy });
      const station = stationByNode.get(to);
      if (station !== undefined && vehicle.chargeStops.has(to) && vehicle.energy < vehicle.batteryCapacity) {
        vehicle.queued = true;
        station.queue.push(vehicle.id);
      }
    }

    for (const station of stations) {
      if (!isOpen(station.windows, tick)) {
        continue;
      }
      let slots = station.capacity;
      const remaining: string[] = [];
      for (const vehicleId of station.queue) {
        const vehicle = vehicleById.get(vehicleId) as VehicleRuntime;
        if (slots > 0) {
          slots -= 1;
          const before = vehicle.energy;
          vehicle.energy = Math.min(vehicle.batteryCapacity, vehicle.energy + station.chargePerTick);
          station.granted.push(vehicleId);
          ledger.push({ tick, vehicleId, kind: "charge", delta: vehicle.energy - before, before, after: vehicle.energy });
          if (vehicle.energy < vehicle.batteryCapacity) {
            remaining.push(vehicleId);
          } else {
            vehicle.queued = false;
          }
        } else {
          remaining.push(vehicleId);
        }
      }
      station.queue = remaining;
    }

    for (const station of stations) {
      for (const vehicleId of station.queue) {
        if (station.granted.includes(vehicleId)) {
          continue;
        }
        const vehicle = vehicleById.get(vehicleId) as VehicleRuntime;
        const drain = Math.min(vehicle.auxDrainPerTick, vehicle.energy);
        if (drain > 0) {
          const before = vehicle.energy;
          vehicle.energy -= drain;
          ledger.push({ tick, vehicleId, kind: "aux-drain", delta: -drain, before, after: vehicle.energy });
        }
      }
    }

    const vehicleSnapshots: VehicleSnapshot[] = vehicles.map((vehicle) => {
      let status: VehicleStatus;
      if (vehicle.queued) {
        status = "queued";
      } else if (vehicle.nodeIndex + 1 >= vehicle.path.length) {
        status = "done";
      } else {
        const from = vehicle.path[vehicle.nodeIndex] as string;
        const to = vehicle.path[vehicle.nodeIndex + 1] as string;
        const edge = edgeByKey.get(`${from}->${to}`) as EdgeSpec;
        status = vehicle.energy < edge.energy ? "stranded" : "ready";
      }
      return {
        id: vehicle.id,
        nodeIndex: vehicle.nodeIndex,
        node: vehicle.path[vehicle.nodeIndex] as string,
        energy: vehicle.energy,
        status,
      };
    });
    const stationSnapshots: StationSnapshot[] = stations.map((station) => ({
      node: station.node,
      queue: [...station.queue],
      granted: [...station.granted],
      open: isOpen(station.windows, tick),
    }));
    snapshots.push({ tick, vehicles: vehicleSnapshots, stations: stationSnapshots });
  }

  return { config, snapshots, ledger };
}

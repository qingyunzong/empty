import {
  RedisReplyError,
  keySlot,
  notSentError,
  unknownDeliveryError,
} from "../../build/src/index.js";

const SLOT_COUNT = 16384;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function endpoint(node) {
  return `${node.host}:${node.port}`;
}

function rangesFor(owners, nodes) {
  const ranges = [];
  let start = 0;
  let owner = owners[0];

  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    if (slot === SLOT_COUNT || owners[slot] !== owner) {
      if (owner) {
        ranges.push({ start, end: slot - 1, owner });
      }
      start = slot;
      owner = owners[slot];
    }
  }

  return ranges;
}

/**
 * A tiny deterministic Redis Cluster with one keyspace, slot ownership,
 * migration markers, ASKING handling and fault injection.
 */
export class FakeCluster {
  constructor(nodeSpecs) {
    this.nodes = new Map();
    for (const spec of nodeSpecs) {
      this.nodes.set(spec.id, { ...spec });
    }
    this.owners = new Array(SLOT_COUNT).fill(null);
    this.migrations = new Map();
    this.keys = new Map();
    this.log = [];
    this.effects = [];
    this.faults = new Map();
    this.delays = new Map();
  }

  node(id) {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Unknown fake cluster node ${id}`);
    }
    return node;
  }

  setSlotOwner(slot, nodeId) {
    this.node(nodeId);
    this.owners[slot] = nodeId;
  }

  ownerOf(slot) {
    return this.owners[slot];
  }

  startMigration(slot, from, to) {
    const source = this.node(from);
    const target = this.node(to);
    if (this.owners[slot] !== from) {
      throw new Error(`Slot ${slot} is owned by ${this.owners[slot]}, not ${from}`);
    }
    this.migrations.set(slot, { slot, from, to, source, target });
  }

  moveKey(key, to) {
    this.node(to);
    const state = this.keys.get(key);
    if (state) {
      state.node = to;
    }
  }

  finishMigration(slot) {
    const migration = this.migrations.get(slot);
    if (!migration) {
      throw new Error(`Slot ${slot} is not migrating`);
    }
    this.owners[slot] = migration.to;
    this.migrations.delete(slot);
    for (const [key, state] of this.keys) {
      if (keySlot(key) === slot) {
        state.node = migration.to;
      }
    }
  }

  snapshot(epoch = 1) {
    return {
      epoch,
      nodes: Object.fromEntries(
        [...this.nodes.values()].map((node) => [
          node.id,
          { host: node.host, port: node.port },
        ]),
      ),
      slots: rangesFor(this.owners, this.nodes),
      migrations: [...this.migrations.values()].map((migration) => ({
        slot: migration.slot,
        from: migration.from,
        to: migration.to,
        state: "migrating",
      })),
    };
  }

  injectFault(key, mode, times = 1) {
    const queue = this.faults.get(key) ?? [];
    queue.push({ mode, times });
    this.faults.set(key, queue);
  }

  setDelay(key, milliseconds) {
    this.delays.set(key, milliseconds);
  }

  executionCount(key) {
    return this.effects.filter((effect) => effect.key === key).length;
  }

  appliedCount(key) {
    return this.effects.filter((effect) => effect.key === key).length;
  }

  attempts(nodeId, key) {
    return this.log.filter((entry) => entry.node === nodeId && entry.key === key);
  }

  async execute(nodeOrId, command, context = {}) {
    const node = typeof nodeOrId === "string" ? this.node(nodeOrId) : nodeOrId;
    if (!this.nodes.has(node.id)) {
      throw new Error(`Transport called with an unknown node ${node.id}`);
    }
    const key = command.key;
    const asking = context.asking === true;

    if (key !== null) {
      const slot = keySlot(key);
      const owner = this.owners[slot];
      if (!owner) {
        throw new RedisReplyError(`CLUSTERDOWN Hash slot not served`);
      }

      const migration = this.migrations.get(slot);
      const importingTarget = migration && node.id === migration.to && asking;
      if (owner !== node.id && !importingTarget) {
        const ownerNode = this.node(owner);
        throw new RedisReplyError(`MOVED ${slot} ${endpoint(ownerNode)}`);
      }

      if (migration) {
        if (asking && node.id !== migration.to) {
          throw new RedisReplyError(`ERR ASKING is only valid on the importing node`);
        }
        if (!asking) {
          const state = this.keys.get(key);
          if (state && state.node !== node.id) {
            throw new RedisReplyError(`ASK ${slot} ${endpoint(migration.target)}`);
          }
        }
      } else if (asking && node.id !== owner) {
        throw new RedisReplyError(`MOVED ${slot} ${endpoint(this.node(owner))}`);
      }
    }

    const pause = key === null ? 0 : (this.delays.get(key) ?? 0);
    if (pause > 0) {
      await delay(pause);
    }

    const fault = key === null ? undefined : this.faults.get(key)?.[0];
    if (fault && fault.mode === "not-sent-before") {
      fault.times -= 1;
      if (fault.times <= 0) {
        this.faults.get(key).shift();
      }
      throw notSentError("connection refused before write");
    }
    if (fault && fault.mode === "server-error-before") {
      fault.times -= 1;
      if (fault.times <= 0) {
        this.faults.get(key).shift();
      }
      throw new RedisReplyError("TRYAGAIN The slot is migrating");
    }

    const value = this.apply(node.id, command, asking);
    this.log.push({
      node: node.id,
      key,
      command: command.name,
      args: command.args,
      asking,
    });

    if (fault && fault.mode === "unknown-after") {
      fault.times -= 1;
      if (fault.times <= 0) {
        this.faults.get(key).shift();
      }
      throw unknownDeliveryError("reply was lost after the command was written");
    }

    return value;
  }

  apply(nodeId, command, asking) {
    const key = command.key;
    if (key === null) {
      if (command.name === "PING") {
        return "PONG";
      }
      return "OK";
    }

    const slot = keySlot(key);
    const migration = this.migrations.get(slot);
    if (asking && migration && nodeId !== migration.to) {
      throw new RedisReplyError("ERR ASKING without an importing slot");
    }

    let state = this.keys.get(key);
    if (!state) {
      state = { key, node: nodeId, value: null };
      this.keys.set(key, state);
    }
    state.node = nodeId;

    switch (command.name) {
      case "GET": {
        return state.value === null ? null : String(state.value);
      }
      case "SET": {
        state.value = command.args[1] ?? null;
        this.effects.push({ key, node: nodeId, command: command.name });
        return "OK";
      }
      case "INCR": {
        state.value = Number(state.value ?? 0) + 1;
        this.effects.push({ key, node: nodeId, command: command.name });
        return state.value;
      }
      case "INCRBY": {
        state.value = Number(state.value ?? 0) + Number(command.args[1] ?? 0);
        this.effects.push({ key, node: nodeId, command: command.name });
        return state.value;
      }
      case "DEL": {
        this.keys.delete(key);
        this.effects.push({ key, node: nodeId, command: command.name });
        return 1;
      }
      default: {
        this.effects.push({ key, node: nodeId, command: command.name });
        return "OK";
      }
    }
  }
}

export class MutableTopology {
  constructor(cluster) {
    this.cluster = cluster;
    this.epoch = 0;
    this.pending = null;
  }

  load() {
    if (this.pending) {
      return this.pending;
    }
    this.epoch += 1;
    return this.cluster.snapshot(this.epoch);
  }

  hold() {
    this.epoch += 1;
    const captured = this.cluster.snapshot(this.epoch);
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    this.pending = promise.then(() => {
      this.pending = null;
      return captured;
    });
    return () => release();
  }
}

export function findKeyInRange(start, end, prefix = "key") {
  for (let index = 0; ; index += 1) {
    const key = `${prefix}${index}`;
    const slot = keySlot(key);
    if (slot >= start && slot <= end) {
      return key;
    }
  }
}

export function endpointOf(cluster, id) {
  const node = cluster.node(id);
  return endpoint(node);
}

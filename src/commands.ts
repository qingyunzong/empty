import { keySlot } from "./crc16.js";
import { CrossSlotError } from "./errors.js";
import type { RedisArgument, RoutableCommand, WireCommand } from "./types.js";

/**
 * Key positions use zero-based indexes into `args` (the command name is not
 * included). `lastKey: -1` means "through the final argument".
 */
export interface KeySpec {
  readonly firstKey: number;
  readonly lastKey?: number;
  readonly step?: number;
}

export interface CommandDefinition {
  readonly keys?: KeySpec | ((args: readonly string[]) => readonly string[]);
  readonly idempotent?: boolean;
}

export interface PreparedCommand {
  readonly command: RoutableCommand;
  readonly name: string;
  readonly args: readonly string[];
  readonly keys: readonly string[];
  readonly slot: number | null;
  readonly idempotent: boolean;
  readonly wire: WireCommand;
}

const READ_COMMANDS = [
  "get",
  "getbit",
  "getrange",
  "strlen",
  "mget",
  "exists",
  "ttl",
  "pttl",
  "expiretime",
  "pexpiretime",
  "type",
  "lrange",
  "llen",
  "lindex",
  "lpos",
  "hget",
  "hmget",
  "hgetall",
  "hkeys",
  "hvals",
  "hlen",
  "hexists",
  "hstrlen",
  "hmget",
  "sismember",
  "smismember",
  "smembers",
  "scard",
  "srandmember",
  "zscore",
  "zmscore",
  "zrange",
  "zrangebyscore",
  "zrangebylex",
  "zrevrange",
  "zrevrangebyscore",
  "zrevrangebylex",
  "zcount",
  "zlexcount",
  "zcard",
  "zrank",
  "zrevrank",
  "zrandmember",
  "geodist",
  "geopos",
  "geohash",
  "geosearch",
  "bitcount",
  "bitpos",
  "bitfield_ro",
  "xlen",
  "xrange",
  "xrevrange",
  "keys",
  "scan",
  "randomkey",
  "dbsize",
  "ping",
  "echo",
  "info",
  "time",
  "lastsave",
] as const;

const singleKeyCommands = [
  "get",
  "set",
  "setnx",
  "setex",
  "psetex",
  "getset",
  "getdel",
  "getex",
  "append",
  "incr",
  "decr",
  "incrby",
  "decrby",
  "incrbyfloat",
  "setrange",
  "setbit",
  "bitcount",
  "bitpos",
  "bitfield",
  "bitfield_ro",
  "expire",
  "pexpire",
  "expireat",
  "pexpireat",
  "ttl",
  "pttl",
  "expiretime",
  "pexpiretime",
  "persist",
  "type",
  "strlen",
  "getrange",
  "lpush",
  "rpush",
  "lpushx",
  "rpushx",
  "lpop",
  "rpop",
  "llen",
  "lindex",
  "lset",
  "linsert",
  "lrem",
  "ltrim",
  "lrange",
  "lpos",
  "hset",
  "hsetnx",
  "hget",
  "hmget",
  "hmset",
  "hdel",
  "hlen",
  "hexists",
  "hincrby",
  "hincrbyfloat",
  "hkeys",
  "hvals",
  "hgetall",
  "hstrlen",
  "hrandfield",
  "sadd",
  "srem",
  "smembers",
  "sismember",
  "smismember",
  "scard",
  "srandmember",
  "spop",
  "zadd",
  "zincrby",
  "zrem",
  "zscore",
  "zmscore",
  "zrange",
  "zrangebyscore",
  "zrangebylex",
  "zrevrange",
  "zrevrangebyscore",
  "zrevrangebylex",
  "zcount",
  "zlexcount",
  "zcard",
  "zrank",
  "zrevrank",
  "zremrangebyscore",
  "zremrangebyrank",
  "zremrangebylex",
  "zrandmember",
  "zpopmin",
  "zpopmax",
  "bzpopmin",
  "bzpopmax",
  "xlen",
  "xrange",
  "xrevrange",
  "xadd",
  "xtrim",
  "xdel",
  "xinfo",
  "geoadd",
  "geodist",
  "geohash",
  "geopos",
  "geosearch",
  "georadius",
  "georadius_ro",
  "georadiusbymember",
  "georadiusbymember_ro",
  "pfadd",
  "pfcount",
  "bitop",
  "sort",
  "sort_ro",
  "dump",
  "restore",
  "object",
] as const;

const allKeyCommands = [
  "mget",
  "del",
  "unlink",
  "exists",
  "touch",
  "watch",
  "sinter",
  "sunion",
  "sdiff",
  "sinterstore",
  "sunionstore",
  "sdiffstore",
  "pfcount",
  "pfmerge",
] as const;

const pairKeyCommands = [
  "rename",
  "renamenx",
  "smove",
  "lmove",
  "blmove",
  "rpoplpush",
  "brpoplpush",
  "copy",
  "zrangestore",
  "geosearchstore",
  "zdiffstore",
  "zunionstore",
  "zinterstore",
] as const;

const readOnly = new Set<string>(READ_COMMANDS);

function toArgument(value: RedisArgument): string {
  return typeof value === "number" ? String(value) : value;
}

function evalKeys(args: readonly string[]): readonly string[] {
  const count = Number.parseInt(args[0] ?? "0", 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`Invalid numkeys value: ${args[0] ?? "<missing>"}`);
  }
  if (count === 0) {
    return [];
  }
  if (args.length < count + 1) {
    throw new TypeError(`EVAL declares ${count} keys but only ${args.length - 1} were provided`);
  }
  return args.slice(1, count + 1);
}

function xreadKeys(args: readonly string[]): readonly string[] {
  const streams = args.findIndex((arg) => arg.toUpperCase() === "STREAMS");
  if (streams < 0) {
    return [];
  }
  const remaining = args.length - streams - 1;
  const count = Math.floor(remaining / 2);
  return args.slice(streams + 1, streams + 1 + count);
}

function bitopKeys(args: readonly string[]): readonly string[] {
  // BITOP <AND|OR|XOR|NOT> <destination> <source> [<source> ...]
  return args.length >= 2 ? args.slice(1) : [];
}

function zstoreKeys(args: readonly string[]): readonly string[] {
  // <command> <destination> <numkeys> <key> [<key> ...]
  if (args.length < 2) {
    return args.length === 1 ? [args[0]!] : [];
  }
  const count = Number.parseInt(args[1] ?? "0", 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    return [args[0]!];
  }
  return [args[0]!, ...args.slice(2, 2 + count)];
}

function numberedKeys(
  args: readonly string[],
  numkeysIndex: number,
  firstKeyIndex: number,
): readonly string[] {
  const count = Number.parseInt(args[numkeysIndex] ?? "", 10);
  if (!Number.isSafeInteger(count) || count < 0) {
    return args[firstKeyIndex] === undefined ? [] : [args[firstKeyIndex]!];
  }
  return args.slice(firstKeyIndex, firstKeyIndex + count);
}

function sortKeys(args: readonly string[]): readonly string[] {
  // SORT <key> [BY pattern] [LIMIT ...] [GET ...] [STORE <destination>]
  const keys: string[] = [];
  if (args[0] !== undefined) {
    keys.push(args[0]);
  }
  for (let index = 1; index < args.length; index += 1) {
    if (args[index]?.toUpperCase() === "STORE" && args[index + 1] !== undefined) {
      keys.push(args[index + 1]!);
      index += 1;
    }
  }
  return keys;
}

function georadiusKeys(args: readonly string[]): readonly string[] {
  // GEORADIUS <key> ... [STORE <key>] [STOREDIST <key>]
  const keys: string[] = [];
  if (args[0] !== undefined) {
    keys.push(args[0]);
  }
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index]?.toUpperCase();
    if ((option === "STORE" || option === "STOREDIST") && args[index + 1] !== undefined) {
      keys.push(args[index + 1]!);
      index += 1;
    }
  }
  return keys;
}

const specs = new Map<string, CommandDefinition>();

for (const name of singleKeyCommands) {
  const keys = name === "object" ? { firstKey: 1, lastKey: 1 } : { firstKey: 0, lastKey: 0 };
  specs.set(name, { keys, idempotent: readOnly.has(name) });
}

for (const name of allKeyCommands) {
  specs.set(name, { keys: { firstKey: 0, lastKey: -1, step: 1 }, idempotent: readOnly.has(name) });
}

for (const name of pairKeyCommands) {
  specs.set(name, { keys: { firstKey: 0, lastKey: 1, step: 1 }, idempotent: false });
}

specs.set("mset", { keys: { firstKey: 0, lastKey: -1, step: 2 }, idempotent: false });
specs.set("msetnx", { keys: { firstKey: 0, lastKey: -1, step: 2 }, idempotent: false });
specs.set("eval", { keys: evalKeys, idempotent: false });
specs.set("evalsha", { keys: evalKeys, idempotent: false });
specs.set("eval_ro", { keys: evalKeys, idempotent: true });
specs.set("evalsha_ro", { keys: evalKeys, idempotent: true });
specs.set("fcall", { keys: evalKeys, idempotent: false });
specs.set("fcall_ro", { keys: evalKeys, idempotent: true });
specs.set("xread", { keys: xreadKeys, idempotent: true });
specs.set("xreadgroup", { keys: xreadKeys, idempotent: false });
specs.set("bitop", { keys: bitopKeys, idempotent: false });
specs.set("sort", { keys: sortKeys, idempotent: false });
specs.set("sort_ro", { keys: { firstKey: 0, lastKey: 0 }, idempotent: true });
specs.set("georadius", { keys: georadiusKeys, idempotent: false });
specs.set("georadiusbymember", { keys: georadiusKeys, idempotent: false });
specs.set("georadius_ro", { keys: { firstKey: 0, lastKey: 0 }, idempotent: true });
specs.set("georadiusbymember_ro", { keys: { firstKey: 0, lastKey: 0 }, idempotent: true });

// Multi-key pop/cardinality commands start with a numkeys field.
for (const name of ["zdiff", "zunion", "zinter", "sintercard", "zintercard"] as const) {
  specs.set(name, {
    keys: (args) => numberedKeys(args, 0, 1),
    idempotent: true,
  });
}
for (const name of ["lmpop", "zmpop"] as const) {
  specs.set(name, {
    keys: (args) => numberedKeys(args, 0, 1),
    idempotent: false,
  });
}
for (const name of ["blmpop", "bzmpop"] as const) {
  specs.set(name, {
    keys: (args) => numberedKeys(args, 1, 2),
    idempotent: false,
  });
}

// Streams introspection/consumer-group commands keep the key after the
// subcommand.
for (const name of ["xinfo", "xgroup", "memory"] as const) {
  specs.set(name, { keys: { firstKey: 1, lastKey: 1 }, idempotent: false });
}
for (const name of ["xack", "xpending", "xclaim", "xautoclaim", "xsetid"] as const) {
  specs.set(name, { keys: { firstKey: 0, lastKey: 0 }, idempotent: false });
}

// The store variants use a destination followed by numkeys source keys.
for (const name of ["zdiffstore", "zunionstore", "zinterstore"] as const) {
  specs.set(name, { keys: zstoreKeys, idempotent: false });
}

// Commands that are safe to repeat without changing the result.
for (const name of ["del", "unlink", "set", "expire", "pexpire", "persist", "hset", "hdel", "sadd", "srem", "zadd", "zrem"]) {
  const current = specs.get(name);
  specs.set(name, { ...current, idempotent: true });
}

const DEFAULT_CATALOG = specs;

export class CommandCatalog {
  readonly #definitions: Map<string, CommandDefinition>;

  constructor(definitions?: ReadonlyMap<string, CommandDefinition> | Readonly<Record<string, CommandDefinition>>) {
    this.#definitions = new Map(
      [...DEFAULT_CATALOG].map(([name, definition]) => [name.toUpperCase(), definition]),
    );
    if (definitions) {
      const entries = definitions instanceof Map ? definitions : Object.entries(definitions);
      for (const [name, definition] of entries) {
        this.#definitions.set(name.toUpperCase(), definition);
      }
    }
  }

  get(name: string): CommandDefinition | undefined {
    return this.#definitions.get(name.toUpperCase());
  }

  extractKeys(name: string, args: readonly string[]): readonly string[] {
    const definition = this.get(name);
    if (!definition?.keys) {
      return [];
    }
    if (typeof definition.keys === "function") {
      return definition.keys(args);
    }
    const { firstKey, lastKey = firstKey, step = 1 } = definition.keys;
    const end = lastKey < 0 ? args.length - 1 : Math.min(lastKey, args.length - 1);
    const keys: string[] = [];
    for (let index = firstKey; index <= end; index += step) {
      const key = args[index];
      if (key === undefined) {
        break;
      }
      keys.push(key);
    }
    return keys;
  }

  isIdempotent(name: string): boolean {
    return this.get(name)?.idempotent === true;
  }
}

export const defaultCommandCatalog = new CommandCatalog();

export function prepareCommand(
  command: RoutableCommand,
  catalog: CommandCatalog = defaultCommandCatalog,
): PreparedCommand {
  if (command === null || typeof command !== "object") {
    throw new TypeError("Command must be an object");
  }
  if (typeof command.name !== "string" || command.name.length === 0) {
    throw new TypeError("Command name must be a non-empty string");
  }

  const name = command.name.toUpperCase();
  const args = (command.args ?? []).map(toArgument);
  const keys = command.keys ? [...command.keys] : [...catalog.extractKeys(name, args)];

  let slot: number | null = null;
  if (keys.length > 0) {
    const slots = keys.map(keySlot);
    const first = slots[0]!;
    const crossSlot = slots.some((candidate) => candidate !== first);
    if (crossSlot) {
      throw new CrossSlotError(name, keys, slots);
    }
    slot = first;
  }

  return {
    command,
    name,
    args,
    keys,
    slot,
    idempotent: command.idempotent ?? catalog.isIdempotent(name),
    wire: {
      name,
      args,
      key: keys[0] ?? null,
      idempotent: command.idempotent ?? catalog.isIdempotent(name),
    },
  };
}

export function commandKeys(
  command: RoutableCommand,
  catalog: CommandCatalog = defaultCommandCatalog,
): readonly string[] {
  if (!command || typeof command.name !== "string") {
    throw new TypeError("Command name must be a non-empty string");
  }
  const name = command.name.toUpperCase();
  const args = (command.args ?? []).map(toArgument);
  return command.keys ? [...command.keys] : catalog.extractKeys(name, args);
}

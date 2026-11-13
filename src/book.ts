import type {
  OrderBook,
  OrderBookLevel,
  OrderBookDelta,
  OrderBookSnapshot,
} from "./types.ts";

export interface NormalizedLevel {
  readonly price: number;
  readonly size: number;
}

export interface NormalizedSnapshot {
  readonly channel: string;
  readonly sequence: number;
  readonly bids: readonly NormalizedLevel[];
  readonly asks: readonly NormalizedLevel[];
  readonly timestamp?: number;
}

export interface NormalizedDelta {
  readonly channel: string;
  readonly sequence: number;
  readonly bids: readonly NormalizedLevel[];
  readonly asks: readonly NormalizedLevel[];
  readonly timestamp?: number;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseLevel(value: unknown): ParseResult<NormalizedLevel> {
  let priceInput: unknown;
  let sizeInput: unknown;

  if (Array.isArray(value)) {
    [priceInput, sizeInput] = value;
  } else if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    priceInput = candidate["price"];
    sizeInput = candidate["size"];
  } else {
    return { ok: false, message: "price level must be a tuple or object" };
  }

  const price = parseNumeric(priceInput);
  const size = parseNumeric(sizeInput);

  if (price === null) {
    return { ok: false, message: "price must be a finite number" };
  }
  if (size === null || size < 0) {
    return {
      ok: false,
      message: "size must be a finite, non-negative number",
    };
  }

  return { ok: true, value: { price, size } };
}

function parseLevels(
  value: unknown,
  label: string,
  required: boolean,
): ParseResult<readonly NormalizedLevel[]> {
  if (value === undefined && !required) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: `${label} must be an array` };
  }

  const levels: NormalizedLevel[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseLevel(value[index]);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `${label}[${index}] is invalid: ${parsed.message}`,
      };
    }
    levels.push(parsed.value);
  }

  return { ok: true, value: levels };
}

function parseChannel(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value;
}

function parseSequence(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null;
  }
  return value;
}

function parseTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function normalizeSnapshot(
  snapshot: OrderBookSnapshot,
): ParseResult<NormalizedSnapshot> {
  const channel = parseChannel(snapshot?.channel);
  if (channel === null) {
    return { ok: false, message: "snapshot channel must be a non-empty string" };
  }

  const sequence = parseSequence(snapshot.sequence);
  if (sequence === null) {
    return {
      ok: false,
      message: "snapshot sequence must be a non-negative safe integer",
    };
  }

  const bids = parseLevels(snapshot.bids, "bids", true);
  if (!bids.ok) {
    return { ok: false, message: bids.message };
  }

  const asks = parseLevels(snapshot.asks, "asks", true);
  if (!asks.ok) {
    return { ok: false, message: asks.message };
  }

  return {
    ok: true,
    value: {
      channel,
      sequence,
      bids: bids.value,
      asks: asks.value,
      timestamp: parseTimestamp(snapshot.timestamp),
    },
  };
}

export function normalizeDelta(
  delta: OrderBookDelta,
): ParseResult<NormalizedDelta> {
  const channel = parseChannel(delta?.channel);
  if (channel === null) {
    return { ok: false, message: "delta channel must be a non-empty string" };
  }

  const sequence = parseSequence(delta.sequence);
  if (sequence === null) {
    return {
      ok: false,
      message: "delta sequence must be a non-negative safe integer",
    };
  }

  const bids = parseLevels(delta.bids, "bids", false);
  if (!bids.ok) {
    return { ok: false, message: bids.message };
  }

  const asks = parseLevels(delta.asks, "asks", false);
  if (!asks.ok) {
    return { ok: false, message: asks.message };
  }

  return {
    ok: true,
    value: {
      channel,
      sequence,
      bids: bids.value,
      asks: asks.value,
      timestamp: parseTimestamp(delta.timestamp),
    },
  };
}

export function buildSnapshotMaps(
  levels: readonly NormalizedLevel[],
): Map<number, number> {
  const result = new Map<number, number>();
  for (const level of levels) {
    if (level.size === 0) {
      result.delete(level.price);
    } else {
      result.set(level.price, level.size);
    }
  }
  return result;
}

export function applyLevels(
  side: Map<number, number>,
  levels: readonly NormalizedLevel[],
): void {
  for (const level of levels) {
    if (level.size === 0) {
      side.delete(level.price);
    } else {
      side.set(level.price, level.size);
    }
  }
}

function sideToLevels(
  side: ReadonlyMap<number, number>,
  direction: "asc" | "desc",
): readonly OrderBookLevel[] {
  const levels: OrderBookLevel[] = [];
  for (const [price, size] of side) {
    levels.push({ price, size });
  }
  levels.sort((left, right) =>
    direction === "asc" ? left.price - right.price : right.price - left.price,
  );
  return levels;
}

export function buildBook(
  channel: string,
  sequence: number,
  snapshotSequence: number,
  bids: ReadonlyMap<number, number>,
  asks: ReadonlyMap<number, number>,
  timestamp: number | undefined,
): OrderBook {
  return {
    channel,
    sequence,
    snapshotSequence,
    bids: sideToLevels(bids, "desc"),
    asks: sideToLevels(asks, "asc"),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

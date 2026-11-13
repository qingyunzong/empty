/**
 * Dynamic session windows for out-of-order event streams.
 *
 * Every event defines its own forward gap:
 *
 *     [timestamp, timestamp + gapMs]
 *
 * A session is a connected component of these intervals for one key. Two
 * intervals belong to the same component when they overlap or touch. This
 * formulation is deterministic regardless of arrival order and naturally
 * supports an event that bridges several sessions.
 */

export type SessionWindowStatus = 'open' | 'triggered' | 'closed';

export interface SessionEvent {
  id?: string | number;
  eventId?: string | number;
  key?: string | number;
  timestamp?: number;
  ts?: number;
  time?: number;
  gapMs?: number;
  gap?: number;
  sessionGapMs?: number;
  gapAfterMs?: number;
  [attribute: string]: unknown;
}

export interface SessionWindowOptions<E = SessionEvent> {
  /** Preferred name for the timestamp extractor. */
  getTimestamp?: (event: E) => number;
  /** Alias for getTimestamp. */
  timestamp?: (event: E) => number;

  /** Preferred name for the event gap extractor. */
  getGap?: (event: E) => number;
  /** Alias for getGap. */
  gap?: ((event: E) => number) | number;

  /** Preferred name for the key extractor. */
  getKey?: (event: E) => string | number | undefined | null;
  /** Alias for getKey. */
  key?: ((event: E) => string | number | undefined | null) | string | number;

  /** Preferred name for the event id extractor. */
  getId?: (event: E) => string | number | undefined | null;
  /** Alias for getId. */
  id?: (event: E) => string | number | undefined | null;

  /** Gap used when an event does not carry one. */
  gapMs?: number;
  /** Alias for gapMs. */
  defaultGapMs?: number;

  /** Key used when an event does not carry one. Defaults to "". */
  defaultKey?: string;
}

export interface SessionWindow<E = SessionEvent> {
  /** Stable identity for this component generation. */
  readonly id: string;
  readonly key: string;
  /** Timestamp of the earliest event in the component. */
  readonly start: number;
  /** Maximum interval end, i.e. max(timestamp + gapMs). */
  readonly end: number;
  /** Timestamp of the latest event in the component. */
  readonly lastTimestamp: number;
  /** Gap carried by the latest event. */
  readonly gapMs: number;
  /** Events in timestamp order (id and insertion order break ties). */
  readonly events: readonly E[];
  readonly eventIds: readonly string[];
  /** Monotonic revision number for the component generation. */
  readonly version: number;
  readonly status: SessionWindowStatus;
  readonly triggered: boolean;
  readonly closed: boolean;
  readonly watermarkAtEmission?: number;
  readonly closedAtWatermark?: number;
}

export type IngestRejectionReason = 'late' | 'duplicate' | 'duplicate-id';

export interface IngestResult<E = SessionEvent> {
  readonly accepted: boolean;
  readonly reason?: IngestRejectionReason;
  readonly event?: E;
  readonly eventId?: string;
  /**
   * Previously published versions that are no longer valid. A bridge retracts
   * every version it replaces.
   */
  readonly retracted: readonly SessionWindow<E>[];
  /** Newly published versions. A bridge publishes exactly one merged version. */
  readonly emitted: readonly SessionWindow<E>[];
  /** Always empty for ingestion; closure is reported by advanceWatermark. */
  readonly closed: readonly SessionWindow<E>[];
  /** Alias for retracted. */
  readonly retractions: readonly SessionWindow<E>[];
  /** Alias for emitted. */
  readonly emissions: readonly SessionWindow<E>[];
  /** Current open windows for the event's key after this operation. */
  readonly openWindows: readonly SessionWindow<E>[];
  /** Alias for openWindows. */
  readonly windows: readonly SessionWindow<E>[];
}

export interface WatermarkResult<E = SessionEvent> {
  readonly watermark: number;
  /** Windows that became immutable at this watermark. */
  readonly closed: readonly SessionWindow<E>[];
  /** Alias for closed. */
  readonly closedWindows: readonly SessionWindow<E>[];
  /** Closing a window is a lifecycle transition, not a data revision. */
  readonly retracted: readonly SessionWindow<E>[];
  readonly emitted: readonly SessionWindow<E>[];
  readonly openWindows: readonly SessionWindow<E>[];
}

export interface SessionWindowSnapshot<E = SessionEvent> {
  readonly watermark: number;
  readonly openWindows: readonly SessionWindow<E>[];
  readonly closedWindows: readonly SessionWindow<E>[];
}

interface StoredEvent<E> {
  readonly id: string;
  readonly key: string;
  readonly timestamp: number;
  readonly gapMs: number;
  readonly event: E;
  readonly order: number;
}

interface Component<E> {
  readonly members: readonly StoredEvent<E>[];
  readonly start: number;
  readonly end: number;
  readonly lastTimestamp: number;
  readonly lastGapMs: number;
}

export type SessionWindowOptionsInput<E> =
  | SessionWindowOptions<E>
  | number
  | ((event: E) => number);

function normalizeOptions<E>(
  input?: SessionWindowOptionsInput<E>,
): SessionWindowOptions<E> {
  if (typeof input === 'number') {
    assertGap(input);
    return { gapMs: input };
  }
  if (typeof input === 'function') {
    return { gap: input };
  }
  return input ?? {};
}

function assertTimestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`event timestamp must be a finite number, got ${String(value)}`);
  }
}

function assertWatermark(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    Number.isNaN(value) ||
    value === Number.NEGATIVE_INFINITY
  ) {
    throw new TypeError(
      `watermark must be a number greater than -Infinity, got ${String(value)}`,
    );
  }
}

function assertGap(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`event gap must be a finite number, got ${String(value)}`);
  }
  if (value < 0) {
    throw new RangeError(`event gap must be non-negative, got ${value}`);
  }
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function asRecord(event: unknown): Record<string, unknown> {
  return event !== null && typeof event === 'object'
    ? (event as Record<string, unknown>)
    : {};
}

function resolveTimestamp<E>(event: E, options: SessionWindowOptions<E>): number {
  const extractor = options.getTimestamp ?? options.timestamp;
  const record = asRecord(event);
  const value = extractor
    ? extractor(event)
    : firstFiniteNumber(record.timestamp, record.ts, record.time);
  assertTimestamp(value);
  return value;
}

function resolveGap<E>(event: E, options: SessionWindowOptions<E>): number {
  const gapOption = options.getGap ?? options.gap;
  const record = asRecord(event);
  let value: unknown;

  if (typeof gapOption === 'function') {
    value = gapOption(event);
  } else {
    value = firstFiniteNumber(
      record.gapMs,
      record.gap,
      record.sessionGapMs,
      record.gapAfterMs,
      typeof gapOption === 'number' ? gapOption : undefined,
      options.gapMs,
      options.defaultGapMs,
    );
  }

  assertGap(value);
  return value;
}

function resolveKey<E>(event: E, options: SessionWindowOptions<E>): string {
  const keyOption = options.getKey ?? options.key;
  const record = asRecord(event);
  let value: unknown;
  if (typeof keyOption === 'function') {
    value = keyOption(event);
  } else {
    value = record.key ?? record.k ?? keyOption;
  }
  if (value === undefined || value === null) {
    return options.defaultKey ?? '';
  }
  return String(value);
}

function resolveExplicitId<E>(
  event: E,
  options: SessionWindowOptions<E>,
): string | undefined {
  const extractor = options.getId ?? options.id;
  const record = asRecord(event);
  const value = extractor ? extractor(event) : (record.id ?? record.eventId);
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

function compareStored<E>(a: StoredEvent<E>, b: StoredEvent<E>): number {
  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return a.order - b.order;
}

function normalizeEvent<E>(
  event: E,
  options: SessionWindowOptions<E>,
  order: number,
  autoId: string,
): StoredEvent<E> {
  const timestamp = resolveTimestamp(event, options);
  const gapMs = resolveGap(event, options);
  const key = resolveKey(event, options);
  const id = resolveExplicitId(event, options) ?? autoId;
  return { id, key, timestamp, gapMs, event, order };
}

function buildComponents<E>(events: readonly StoredEvent<E>[]): Component<E>[] {
  const sorted = [...events].sort(compareStored);
  const components: Component<E>[] = [];
  let members: StoredEvent<E>[] = [];
  let componentEnd = Number.NEGATIVE_INFINITY;

  const finish = (): void => {
    if (members.length === 0) {
      return;
    }
    const first = members[0];
    const last = members[members.length - 1];
    components.push({
      members,
      start: first.timestamp,
      end: componentEnd,
      lastTimestamp: last.timestamp,
      lastGapMs: last.gapMs,
    });
  };

  for (const event of sorted) {
    if (members.length > 0 && event.timestamp > componentEnd) {
      finish();
      members = [];
      componentEnd = Number.NEGATIVE_INFINITY;
    }

    if (members.length === 0) {
      members = [event];
      componentEnd = event.timestamp + event.gapMs;
    } else {
      members.push(event);
      componentEnd = Math.max(componentEnd, event.timestamp + event.gapMs);
    }
  }
  finish();
  return components;
}

function makeWindowId<E>(key: string, component: Component<E>): string {
  const first = component.members[0];
  return `${key}|${first.timestamp}|${first.id}`;
}

function freezeWindow<E>(window: SessionWindow<E>): SessionWindow<E> {
  const events = Object.freeze([...window.events]);
  const eventIds = Object.freeze([...window.eventIds]);
  return Object.freeze({ ...window, events, eventIds });
}

function makeWindow<E>(
  key: string,
  component: Component<E>,
  version: number,
  status: SessionWindowStatus,
  watermark?: number,
): SessionWindow<E> {
  const statusTriggered = status !== 'open';
  const window: SessionWindow<E> = {
    id: makeWindowId(key, component),
    key,
    start: component.start,
    end: component.end,
    lastTimestamp: component.lastTimestamp,
    gapMs: component.lastGapMs,
    events: component.members.map((member) => member.event),
    eventIds: component.members.map((member) => member.id),
    version,
    status,
    triggered: statusTriggered,
    closed: status === 'closed',
    ...(watermark === undefined ? {} : { watermarkAtEmission: watermark }),
    ...(status === 'closed' && watermark !== undefined
      ? { closedAtWatermark: watermark }
      : {}),
  };
  return freezeWindow(window);
}

function finalizeWindow<E>(
  window: SessionWindow<E>,
  watermark: number,
): SessionWindow<E> {
  if (window.closed) {
    return window;
  }
  return freezeWindow({
    ...window,
    status: 'closed',
    triggered: true,
    closed: true,
    closedAtWatermark: watermark,
  });
}

function membersKey(eventIds: readonly string[]): string {
  return JSON.stringify([...eventIds].sort());
}

function seenIdKey(key: string, id: string): string {
  return `${key}\u0000${id}`;
}

function compareWindows<E>(a: SessionWindow<E>, b: SessionWindow<E>): number {
  if (a.key !== b.key) {
    return a.key < b.key ? -1 : 1;
  }
  if (a.start !== b.start) {
    return a.start - b.start;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return a.version - b.version;
}

/**
 * Computes the session-window connected components for a set of events.
 * The result is independent of the input order and respects event keys.
 */
export function connectedComponents<E = SessionEvent>(
  events: readonly E[],
  optionsInput?: SessionWindowOptionsInput<E>,
): E[][] {
  const options = normalizeOptions(optionsInput);
  const byKey = new Map<string, StoredEvent<E>[]>();
  let order = 0;

  for (const event of events) {
    const stored = normalizeEvent(event, options, order, `auto-${order}`);
    order += 1;
    const bucket = byKey.get(stored.key);
    if (bucket) {
      bucket.push(stored);
    } else {
      byKey.set(stored.key, [stored]);
    }
  }

  const result: E[][] = [];
  for (const key of [...byKey.keys()].sort()) {
    for (const component of buildComponents(byKey.get(key) ?? [])) {
      result.push(component.members.map((member) => member.event));
    }
  }
  return result;
}

/** Alias for connectedComponents. */
export const sessionWindowComponents = connectedComponents;
/** Alias for connectedComponents. */
export const computeConnectedComponents = connectedComponents;

/**
 * Pure helper returning open window views for a fixed event set. The returned
 * windows are not stateful and all have version 1.
 */
export function computeSessionWindows<E = SessionEvent>(
  events: readonly E[],
  optionsInput?: SessionWindowOptionsInput<E>,
): SessionWindow<E>[] {
  const options = normalizeOptions(optionsInput);
  const byKey = new Map<string, StoredEvent<E>[]>();
  let order = 0;

  for (const event of events) {
    const stored = normalizeEvent(event, options, order, `auto-${order}`);
    order += 1;
    const bucket = byKey.get(stored.key);
    if (bucket) {
      bucket.push(stored);
    } else {
      byKey.set(stored.key, [stored]);
    }
  }

  const result: SessionWindow<E>[] = [];
  for (const key of [...byKey.keys()].sort()) {
    for (const component of buildComponents(byKey.get(key) ?? [])) {
      result.push(makeWindow(key, component, 1, 'open'));
    }
  }
  return result.sort(compareWindows);
}

/**
 * Stateful, keyed session-window operator.
 *
 * Ingestion publishes window versions immediately. If an event changes or
 * merges existing windows, every replaced version appears in `retracted` and
 * the new component appears exactly once in `emitted`.
 */
export class SessionWindowState<E = SessionEvent> {
  private readonly options: SessionWindowOptions<E>;
  private readonly openEventsByKey = new Map<string, StoredEvent<E>[]>();
  private readonly openByKey = new Map<string, SessionWindow<E>[]>();
  private readonly closedByKey = new Map<string, SessionWindow<E>[]>();
  private readonly seenIds = new Map<string, StoredEvent<E>>();
  private watermarkValue = Number.NEGATIVE_INFINITY;
  private nextOrder = 0;

  constructor(optionsInput?: SessionWindowOptionsInput<E>) {
    this.options = normalizeOptions(optionsInput);
  }

  get watermark(): number {
    return this.watermarkValue;
  }

  get currentWatermark(): number {
    return this.watermarkValue;
  }

  get windows(): readonly SessionWindow<E>[] {
    return this.getOpenWindows();
  }

  get closedWindows(): readonly SessionWindow<E>[] {
    return this.getClosedWindows();
  }

  /** Ingests one event. */
  add(event: E): IngestResult<E> {
    const order = this.nextOrder;
    const stored = normalizeEvent(event, this.options, order, `auto-${order}`);

    const idKey = seenIdKey(stored.key, stored.id);
    const existing = this.seenIds.get(idKey);
    if (existing) {
      const same =
        existing.key === stored.key &&
        existing.timestamp === stored.timestamp &&
        existing.gapMs === stored.gapMs;
      return this.rejected(
        same ? 'duplicate' : 'duplicate-id',
        event,
        stored,
      );
    }

    if (stored.timestamp <= this.watermarkValue) {
      return this.rejected('late', event, stored);
    }

    this.nextOrder += 1;
    const previousEvents = this.openEventsByKey.get(stored.key) ?? [];
    const previousWindows = this.openByKey.get(stored.key) ?? [];
    const nextEvents = [...previousEvents, stored].sort(compareStored);
    const components = buildComponents(nextEvents);

    const oldByMembers = new Map<string, SessionWindow<E>>();
    for (const window of previousWindows) {
      oldByMembers.set(membersKey(window.eventIds), window);
    }

    const emitted: SessionWindow<E>[] = [];
    const retracted: SessionWindow<E>[] = [];
    const nextWindows: SessionWindow<E>[] = [];

    for (const component of components) {
      const eventIds = component.members.map((member) => member.id);
      const exact = oldByMembers.get(membersKey(eventIds));
      if (exact) {
        oldByMembers.delete(membersKey(eventIds));
        nextWindows.push(exact);
        continue;
      }

      const componentIds = new Set(eventIds);
      const lineage = previousWindows.filter((window) =>
        window.eventIds.every((id) => componentIds.has(id)),
      );
      const version =
        lineage.length === 0
          ? 1
          : Math.max(...lineage.map((window) => window.version)) + 1;
      const window = makeWindow(
        stored.key,
        component,
        version,
        'triggered',
        this.watermarkValue,
      );
      emitted.push(window);
      nextWindows.push(window);
    }

    retracted.push(...oldByMembers.values());
    retracted.sort(compareWindows);
    emitted.sort(compareWindows);

    this.seenIds.set(idKey, stored);
    this.openEventsByKey.set(stored.key, nextEvents);
    this.openByKey.set(stored.key, nextWindows.sort(compareWindows));

    return this.result({
      accepted: true,
      event,
      eventId: stored.id,
      retracted,
      emitted,
      openWindows: nextWindows,
    });
  }

  /** Alias for add. */
  push(event: E): IngestResult<E> {
    return this.add(event);
  }

  /** Alias for add. */
  ingest(event: E): IngestResult<E> {
    return this.add(event);
  }

  /** Alias for add. */
  process(event: E): IngestResult<E> {
    return this.add(event);
  }

  /**
   * Advances the event-time watermark. Watermarks are monotonic. Every window
   * whose interval end is at or below the watermark becomes immutable.
   */
  advanceWatermark(watermark: number): WatermarkResult<E> {
    assertWatermark(watermark);
    if (watermark < this.watermarkValue) {
      throw new RangeError(
        `watermark cannot move backwards: current=${this.watermarkValue}, next=${watermark}`,
      );
    }
    this.watermarkValue = watermark;

    const closed: SessionWindow<E>[] = [];
    for (const [key, windows] of this.openByKey) {
      const stillOpen: SessionWindow<E>[] = [];
      const closedEventIds = new Set<string>();
      for (const window of windows) {
        if (window.end <= watermark) {
          const finalWindow = finalizeWindow(window, watermark);
          for (const eventId of window.eventIds) {
            closedEventIds.add(eventId);
          }
          const closedForKey = this.closedByKey.get(key) ?? [];
          closedForKey.push(finalWindow);
          this.closedByKey.set(key, closedForKey);
          closed.push(finalWindow);
        } else {
          stillOpen.push(window);
        }
      }
      if (stillOpen.length === 0) {
        this.openByKey.delete(key);
      } else {
        this.openByKey.set(key, stillOpen);
      }
      const openEvents = (this.openEventsByKey.get(key) ?? []).filter(
        (event) => !closedEventIds.has(event.id),
      );
      if (openEvents.length === 0) {
        this.openEventsByKey.delete(key);
      } else {
        this.openEventsByKey.set(key, openEvents);
      }
    }

    closed.sort(compareWindows);
    return Object.freeze({
      watermark,
      closed: Object.freeze([...closed]),
      closedWindows: Object.freeze([...closed]),
      retracted: Object.freeze([]),
      emitted: Object.freeze([]),
      openWindows: Object.freeze(this.getOpenWindows()),
    });
  }

  /** Alias for advanceWatermark. */
  setWatermark(watermark: number): WatermarkResult<E> {
    return this.advanceWatermark(watermark);
  }

  getOpenWindows(key?: string | number): readonly SessionWindow<E>[] {
    if (key !== undefined) {
      return Object.freeze([...(this.openByKey.get(String(key)) ?? [])]);
    }
    const windows: SessionWindow<E>[] = [];
    for (const bucket of this.openByKey.values()) {
      windows.push(...bucket);
    }
    return Object.freeze(windows.sort(compareWindows));
  }

  getClosedWindows(key?: string | number): readonly SessionWindow<E>[] {
    if (key !== undefined) {
      return Object.freeze([...(this.closedByKey.get(String(key)) ?? [])]);
    }
    const windows: SessionWindow<E>[] = [];
    for (const bucket of this.closedByKey.values()) {
      windows.push(...bucket);
    }
    return Object.freeze(windows.sort(compareWindows));
  }

  getAllWindows(key?: string | number): readonly SessionWindow<E>[] {
    return Object.freeze([
      ...this.getOpenWindows(key),
      ...this.getClosedWindows(key),
    ].sort(compareWindows));
  }

  getWindow(id: string): SessionWindow<E> | undefined {
    for (const window of this.openByKey.values()) {
      const found = window.find((candidate) => candidate.id === id);
      if (found) {
        return found;
      }
    }
    for (const window of this.closedByKey.values()) {
      const found = window.find((candidate) => candidate.id === id);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  hasEvent(id: string | number): boolean {
    const suffix = `\u0000${String(id)}`;
    for (const key of this.seenIds.keys()) {
      if (key.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  }

  /** Stored input events in timestamp order. */
  getEvents(key?: string | number): readonly E[] {
    const requestedKey = key === undefined ? undefined : String(key);
    return Object.freeze(
      [...this.seenIds.values()]
        .filter(
          (stored) =>
            requestedKey === undefined || stored.key === requestedKey,
        )
        .sort((a, b) => compareStored(a, b))
        .map((stored) => stored.event),
    );
  }

  snapshot(): SessionWindowSnapshot<E> {
    return Object.freeze({
      watermark: this.watermarkValue,
      openWindows: this.getOpenWindows(),
      closedWindows: this.getClosedWindows(),
    });
  }

  private rejected(
    reason: IngestRejectionReason,
    event: E,
    stored: StoredEvent<E>,
  ): IngestResult<E> {
    return this.result({
      accepted: false,
      reason,
      event,
      eventId: stored.id,
      retracted: [],
      emitted: [],
      openWindows: this.getOpenWindows(stored.key),
    });
  }

  private result(input: {
    accepted: boolean;
    reason?: IngestRejectionReason;
    event: E;
    eventId: string;
    retracted: SessionWindow<E>[];
    emitted: SessionWindow<E>[];
    openWindows: readonly SessionWindow<E>[];
  }): IngestResult<E> {
    const retracted = Object.freeze([...input.retracted]);
    const emitted = Object.freeze([...input.emitted]);
    const openWindows = Object.freeze([...input.openWindows]);
    return Object.freeze({
      accepted: input.accepted,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      event: input.event,
      eventId: input.eventId,
      retracted,
      emitted,
      closed: Object.freeze([]),
      retractions: retracted,
      emissions: emitted,
      openWindows,
      windows: openWindows,
    });
  }
}

/** Alias for SessionWindowState. */
export { SessionWindowState as SessionWindowStore };
/** Alias for SessionWindowState. */
export { SessionWindowState as SessionWindowOperator };

export function createSessionWindowState<E = SessionEvent>(
  options?: SessionWindowOptionsInput<E>,
): SessionWindowState<E> {
  return new SessionWindowState<E>(options);
}

export function createSessionWindowStore<E = SessionEvent>(
  options?: SessionWindowOptionsInput<E>,
): SessionWindowState<E> {
  return new SessionWindowState<E>(options);
}

export type ReplayEventKind =
  | "beforeInput"
  | "compositionStart"
  | "compositionUpdate"
  | "compositionInput"
  | "compositionEnd"
  | "compositionCancel"
  | "input"
  | "reset"
  | "unknown";

export interface ReplayEvent {
  seq?: number;
  sequence?: number;
  generation?: number;
  gen?: number;
  id?: string;
  eventId?: string;
  type?: string;
  eventType?: string;
  kind?: string;
  value?: string;
  text?: string;
  data?: string;
  beforeInputId?: string;
  beforeInput?: string;
  compositionEndId?: string;
  endEventId?: string;
  endId?: string;
  afterEndId?: string;
  relatedEndId?: string;
  relatedEventId?: string;
  canceled?: boolean;
  cancelled?: boolean;
  defaultPrevented?: boolean;
  [key: string]: unknown;
}

export interface Confirmation {
  value: string;
  sourceId: string;
  [alias: string]: unknown;
}

export interface ReplayOptions {
  events?: readonly ReplayEvent[];
  batch?: readonly ReplayEvent[];
  inputEvents?: readonly ReplayEvent[];
  replayEvents?: readonly ReplayEvent[];
}

export type InputEvent = ReplayEvent;
export type InputEventType = ReplayEventKind;
export type ConfirmedValue = Confirmation;
export type ReplayConfirmation = Confirmation;
export type ReplayOutput = ReplayResult;

export type ReplayResult = Confirmation[] & {
  readonly confirmations: Confirmation[];
  readonly confirmed: Confirmation[];
  readonly records: Confirmation[];
  readonly values: string[];
  readonly confirmedValues: string[];
  readonly sourceIds: string[];
  readonly rolledBack: boolean;
  readonly ok: boolean;
  readonly status: "committed" | "rolledBack";
  readonly rollbackReason?: string;
  readonly value: string;
  readonly finalValue: string;
  readonly generation: number | undefined;
  readonly composing: boolean;
};

type Kind = ReplayEventKind;
type EventRecord = Record<string, unknown>;

interface BeforeInputRecord {
  canceled: boolean;
}

interface PendingEnd {
  id: string;
  value: string;
  generation: number;
}

interface ReplayState {
  generation?: number;
  value: string;
  composing: boolean;
  temporaryValue: string;
  lastSequence: number;
  beforeInputs: Map<string, BeforeInputRecord>;
  endIds: Set<string>;
  pendingEnd?: PendingEnd;
}

interface StateSnapshot {
  generation?: number;
  value: string;
  composing: boolean;
  temporaryValue: string;
  lastSequence: number;
  beforeInputs: Map<string, BeforeInputRecord>;
  endIds: Set<string>;
  pendingEnd?: PendingEnd;
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const asRecord = (value: unknown): EventRecord =>
  value !== null && typeof value === "object" ? (value as EventRecord) : {};

const firstDefined = (
  event: EventRecord,
  keys: readonly string[],
): unknown => {
  for (const key of keys) {
    if (hasOwn(event, key) && event[key] !== undefined) {
      return event[key];
    }
  }
  return undefined;
};

const normalizeKind = (event: ReplayEvent): Kind => {
  const record = asRecord(event);
  const raw = firstDefined(record, [
    "type",
    "eventType",
    "kind",
    "event",
    "name",
  ]);
  if (typeof raw !== "string") {
    return "unknown";
  }

  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  switch (normalized) {
    case "beforeinput":
      return "beforeInput";
    case "compositionstart":
    case "compstart":
    case "startcomposition":
    case "start":
      return "compositionStart";
    case "compositionupdate":
    case "compupdate":
    case "updatecomposition":
    case "update":
      return "compositionUpdate";
    case "compositioninput":
    case "compinput":
    case "inputcomposition":
      return "compositionInput";
    case "compositionend":
    case "compend":
    case "endcomposition":
    case "end":
    case "commit":
      return "compositionEnd";
    case "compositioncancel":
    case "compcancel":
    case "cancelcomposition":
    case "compositionabort":
    case "compabort":
    case "abortcomposition":
    case "cancel":
    case "abort":
      return "compositionCancel";
    case "input":
    case "inserttext":
      return "input";
    case "reset":
    case "replace":
    case "setvalue":
    case "generation":
    case "generationchange":
    case "newgeneration":
    case "init":
    case "initialize":
    case "snapshot":
    case "sync":
      return "reset";
    default:
      return "unknown";
  }
};

const readString = (event: ReplayEvent, keys: readonly string[]): string => {
  const value = firstDefined(asRecord(event), keys);
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : String(value);
};

const readEventValue = (event: ReplayEvent): string =>
  readString(event, [
    "value",
    "text",
    "data",
    "fullValue",
    "currentValue",
    "newValue",
    "initialValue",
    "initial",
    "string",
  ]);

const readGeneration = (
  event: ReplayEvent,
  fallback: number,
): number => {
  const raw = firstDefined(asRecord(event), [
    "generation",
    "gen",
    "revision",
    "controlGeneration",
    "generationId",
  ]);
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readSequence = (
  event: ReplayEvent,
  fallback: number,
): number => {
  const raw = firstDefined(asRecord(event), [
    "seq",
    "sequence",
    "sequenceNumber",
    "sequenceId",
    "seqNo",
    "order",
    "index",
    "serial",
  ]);
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const readId = (event: ReplayEvent, fallback: string): string => {
  const raw = firstDefined(asRecord(event), [
    "id",
    "eventId",
    "eventID",
    "uuid",
    "key",
  ]);
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  return String(raw);
};

const readReferences = (event: ReplayEvent): string[] => {
  const record = asRecord(event);
  const keys = [
    "beforeInputId",
    "beforeInputID",
    "beforeInputEventId",
    "beforeInput",
    "compositionEndId",
    "endEventId",
    "endId",
    "afterEndId",
    "relatedEndId",
    "relatedEventId",
    "relatedId",
    "sourceEventId",
    "fromEventId",
    "afterId",
  ] as const;

  const references: string[] = [];
  for (const key of keys) {
    const raw = record[key];
    if (
      hasOwn(record, key) &&
      raw !== undefined &&
      raw !== null &&
      raw !== ""
    ) {
      references.push(String(raw));
    }
  }
  return references;
};

const isCanceled = (event: ReplayEvent): boolean => {
  const record = asRecord(event);
  for (const key of [
    "canceled",
    "cancelled",
    "isCanceled",
    "isCancelled",
    "defaultPrevented",
    "prevented",
  ]) {
    if (hasOwn(record, key) && Boolean(record[key])) {
      return true;
    }
  }
  const action = firstDefined(record, ["action", "status", "result"]);
  if (typeof action === "string") {
    const normalized = action.toLowerCase();
    if (
      normalized === "cancel" ||
      normalized === "canceled" ||
      normalized === "cancelled" ||
      normalized === "abort" ||
      normalized === "aborted"
    ) {
      return true;
    }
  }
  if (record.commit === false || record.confirmed === false) {
    return true;
  }
  return false;
};

const createState = (): ReplayState => ({
  value: "",
  composing: false,
  temporaryValue: "",
  lastSequence: Number.NEGATIVE_INFINITY,
  beforeInputs: new Map(),
  endIds: new Set(),
});

const snapshotState = (state: ReplayState): StateSnapshot => ({
  generation: state.generation,
  value: state.value,
  composing: state.composing,
  temporaryValue: state.temporaryValue,
  lastSequence: state.lastSequence,
  beforeInputs: new Map(state.beforeInputs),
  endIds: new Set(state.endIds),
  pendingEnd: state.pendingEnd ? { ...state.pendingEnd } : undefined,
});

const restoreState = (state: ReplayState, snapshot: StateSnapshot): void => {
  state.generation = snapshot.generation;
  state.value = snapshot.value;
  state.composing = snapshot.composing;
  state.temporaryValue = snapshot.temporaryValue;
  state.lastSequence = snapshot.lastSequence;
  state.beforeInputs = new Map(snapshot.beforeInputs);
  state.endIds = new Set(snapshot.endIds);
  state.pendingEnd = snapshot.pendingEnd
    ? { ...snapshot.pendingEnd }
    : undefined;
};

const clearComposition = (state: ReplayState): void => {
  state.composing = false;
  state.temporaryValue = "";
  state.pendingEnd = undefined;
};

const beginGeneration = (
  state: ReplayState,
  generation: number,
  value: string,
): void => {
  state.generation = generation;
  state.value = value;
  clearComposition(state);
  state.beforeInputs.clear();
  state.endIds.clear();
};

const confirmation = (value: string, sourceId: string): Confirmation => {
  const result: Confirmation = { value, sourceId };
  Object.defineProperties(result, {
    eventId: { get: () => sourceId, enumerable: false },
    source: { get: () => sourceId, enumerable: false },
    sourceEventId: { get: () => sourceId, enumerable: false },
    sourceID: { get: () => sourceId, enumerable: false },
    source_id: { get: () => sourceId, enumerable: false },
    text: { get: () => value, enumerable: false },
    confirmedValue: { get: () => value, enumerable: false },
  });
  return result;
};

const makeResult = (
  confirmations: Confirmation[],
  state: ReplayState,
  rolledBack: boolean,
  rollbackReason?: string,
): ReplayResult => {
  const result = confirmations as ReplayResult;
  const values = () => confirmations.map((entry) => entry.value);
  const sourceIds = () => confirmations.map((entry) => entry.sourceId);

  Object.defineProperties(result, {
    confirmations: { get: () => result, enumerable: false },
    confirmed: { get: () => result, enumerable: false },
    records: { get: () => result, enumerable: false },
    items: { get: () => result, enumerable: false },
    values: { get: values, enumerable: false },
    confirmedValues: { get: values, enumerable: false },
    sourceIds: { get: sourceIds, enumerable: false },
    rolledBack: { get: () => rolledBack, enumerable: false },
    ok: { get: () => !rolledBack, enumerable: false },
    status: {
      get: () => (rolledBack ? "rolledBack" : "committed"),
      enumerable: false,
    },
    rollbackReason: {
      get: () => rollbackReason,
      enumerable: false,
    },
    value: { get: () => state.value, enumerable: false },
    finalValue: { get: () => state.value, enumerable: false },
    generation: { get: () => state.generation, enumerable: false },
    composing: { get: () => state.composing, enumerable: false },
  });

  return result;
};

class BatchFailure {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

const replayBatch = (
  rawEvents: unknown,
  createStateFrom?: StateSnapshot,
): {
  confirmations: Confirmation[];
  state: ReplayState;
  rolledBack: boolean;
  reason?: string;
} => {
  let eventList: unknown;
  if (Array.isArray(rawEvents)) {
    eventList = rawEvents;
  } else {
    const record = asRecord(rawEvents);
    eventList = firstDefined(record, [
      "events",
      "batch",
      "inputEvents",
      "replayEvents",
      "items",
    ]);
  }

  if (!Array.isArray(eventList)) {
    throw new TypeError("replayInput expects an array of events");
  }

  const state = createState();
  if (createStateFrom) {
    restoreState(state, createStateFrom);
  }
  const initialState = snapshotState(state);
  const confirmations: Confirmation[] = [];

  try {
    eventList.forEach((rawEvent, index) => {
      const event = asRecord(rawEvent) as ReplayEvent;
      const kind = normalizeKind(event);
      const sequence = readSequence(event, index + 1);

      if (sequence <= state.lastSequence) {
        return;
      }
      state.lastSequence = sequence;

      const eventGeneration = readGeneration(
        event,
        state.generation === undefined ? 1 : state.generation,
      );
      const eventValue = readEventValue(event);
      const eventId = readId(event, `event-${index + 1}`);

      if (state.generation !== undefined && eventGeneration < state.generation) {
        return;
      }

      if (
        state.generation === undefined ||
        eventGeneration > state.generation
      ) {
        beginGeneration(state, eventGeneration, eventValue);
      }

      if (kind === "reset") {
        state.value = eventValue;
        clearComposition(state);
        return;
      }

      if (kind === "beforeInput") {
        state.beforeInputs.set(eventId, { canceled: isCanceled(event) });
        return;
      }

      if (kind === "compositionStart") {
        state.composing = true;
        state.temporaryValue = eventValue;
        state.pendingEnd = undefined;
        return;
      }

      if (kind === "compositionUpdate" || kind === "compositionInput") {
        if (!state.composing) {
          throw new BatchFailure(`event ${eventId}: composition is not active`);
        }
        state.temporaryValue = eventValue;
        return;
      }

      if (kind === "compositionEnd") {
        if (!state.composing) {
          throw new BatchFailure(`event ${eventId}: composition is not active`);
        }

        const canceled = isCanceled(event);
        const committedValue = state.temporaryValue;
        const generation = state.generation as number;

        state.composing = false;
        state.temporaryValue = "";
        state.endIds.add(eventId);

        if (canceled) {
          state.pendingEnd = undefined;
          return;
        }

        state.value = committedValue;
        state.pendingEnd = {
          id: eventId,
          value: committedValue,
          generation,
        };
        confirmations.push(confirmation(committedValue, eventId));
        return;
      }

      if (kind === "compositionCancel") {
        if (state.composing) {
          clearComposition(state);
        } else {
          state.pendingEnd = undefined;
        }
        return;
      }

      if (kind === "input") {
        const references = readReferences(event);
        const pendingEnd = state.pendingEnd;
        const generation = state.generation as number;

        if (references.length > 0) {
          let canceled = false;
          let completesComposition = false;

          for (const reference of references) {
            const beforeInput = state.beforeInputs.get(reference);
            if (beforeInput !== undefined) {
              canceled ||= beforeInput.canceled;
            } else if (
              pendingEnd !== undefined &&
              pendingEnd.id === reference &&
              pendingEnd.generation === generation
            ) {
              completesComposition = true;
            } else if (!state.endIds.has(reference)) {
              throw new BatchFailure(
                `event ${eventId}: unknown association ${reference}`,
              );
            }
          }

          if (completesComposition) {
            return;
          }
          state.pendingEnd = undefined;
          if (canceled) {
            return;
          }
        } else {
          state.pendingEnd = undefined;
        }

        if (state.composing) {
          state.temporaryValue = eventValue;
          return;
        }

        state.value = eventValue;
        confirmations.push(confirmation(eventValue, eventId));
        return;
      }
    });
  } catch (error) {
    if (error instanceof BatchFailure) {
      restoreState(state, initialState);
      return {
        confirmations: [],
        state,
        rolledBack: true,
        reason: error.reason,
      };
    }
    throw error;
  }

  return { confirmations, state, rolledBack: false };
};

export function replayInput(
  input: readonly ReplayEvent[] | ReplayOptions,
): ReplayResult {
  const outcome = replayBatch(input);
  return makeResult(
    outcome.confirmations,
    outcome.state,
    outcome.rolledBack,
    outcome.reason,
  );
}

export const replay = replayInput;
export const replayEvents = replayInput;
export const replayInputEvents = replayInput;
export const processInputEvents = replayInput;
export const processEvents = replayInput;
export const runReplay = replayInput;
export const replayBatchEvents = replayInput;
export const replayInputBatch = replayInput;

export class InputReplayer {
  #state?: StateSnapshot;

  replay(input: readonly ReplayEvent[] | ReplayOptions): ReplayResult {
    const outcome = replayBatch(input, this.#state);
    if (!outcome.rolledBack) {
      this.#state = snapshotState(outcome.state);
    }
    return makeResult(
      outcome.confirmations,
      outcome.state,
      outcome.rolledBack,
      outcome.reason,
    );
  }

  process(input: readonly ReplayEvent[] | ReplayOptions): ReplayResult {
    return this.replay(input);
  }

  reset(): void {
    this.#state = undefined;
  }
}

export const ReplayEngine = InputReplayer;
export const ReplaySession = InputReplayer;
export const InputReplay = InputReplayer;

export function createInputReplayer(): InputReplayer {
  return new InputReplayer();
}

export function createReplaySession(): InputReplayer {
  return new InputReplayer();
}

export default replayInput;

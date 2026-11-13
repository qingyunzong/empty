export type ReadinessMode = "all" | "any";
export type TaskState = "waiting" | "ready" | "started";
export type SignalStatus = "applied" | "duplicate" | "stale" | "conflict";

export interface PublishSignal {
  readonly type?: "publish";
  readonly dataset: string;
  readonly partition: string;
  readonly schemaHash: string;
  readonly generation: number;
  readonly producer?: string;
}

export interface WithdrawSignal {
  readonly type?: "withdraw";
  readonly dataset: string;
  readonly partition: string;
  readonly generation: number;
  readonly schemaHash?: string;
  readonly producer?: string;
}

export type DatasetSignal =
  | (Omit<PublishSignal, "type"> & { readonly type: "publish" })
  | (Omit<WithdrawSignal, "type"> & { readonly type: "withdraw" });

export interface DatasetRequirement {
  readonly dataset: string;
  readonly partitions?: readonly string[];
  readonly partitionMode?: ReadinessMode;
  readonly schemaHashes?: readonly string[];
  readonly schemas?: readonly string[];
}

export type RequirementInput = string | DatasetRequirement;

export interface ConsumerDeclaration {
  readonly id?: string;
  readonly mode?: ReadinessMode;
  readonly schemaHashes?: readonly string[];
  readonly schemas?: readonly string[];
  readonly requirements: readonly RequirementInput[];
  readonly onReady?: (snapshot: ReadinessSnapshot) => void;
}

export interface PublicationSnapshot {
  readonly dataset: string;
  readonly partition: string;
  readonly schemaHash: string;
  readonly generation: number;
  readonly producer?: string;
}

export interface ReadinessSnapshot {
  readonly consumerId: string;
  readonly mode: ReadinessMode;
  readonly entries: readonly PublicationSnapshot[];
}

export interface TaskTransition {
  readonly id: string;
  readonly from: Exclude<TaskState, "started">;
  readonly to: Exclude<TaskState, "started">;
}

export interface SignalResult {
  readonly accepted: boolean;
  readonly status: SignalStatus;
  readonly dataset: string;
  readonly partition: string;
  readonly generation: number;
  readonly triggered: readonly string[];
  readonly updated: readonly string[];
  readonly transitions: readonly TaskTransition[];
  readonly detail?: string;
}

export interface ReadinessAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: string, listener: (...args: unknown[]) => void): void;
  removeEventListener(type: string, listener: (...args: unknown[]) => void): void;
}

export interface WaitForReadyOptions {
  readonly signal?: ReadinessAbortSignal;
}

export interface TaskStatus {
  readonly id: string;
  readonly state: TaskState;
  readonly triggerCount: number;
  readonly snapshot: ReadinessSnapshot | undefined;
}

export interface ReadinessTaskHandle {
  readonly id: string;
  readonly state: TaskState;
  readonly triggerCount: number;
  snapshot(): ReadinessSnapshot | undefined;
  start(): ReadinessSnapshot;
  tryStart(): ReadinessSnapshot | null;
  waitForReady(options?: WaitForReadyOptions): Promise<ReadinessSnapshot>;
  unregister(): boolean;
}

export class DatasetReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidSignalError extends DatasetReadinessError {}
export class InvalidDeclarationError extends DatasetReadinessError {}
export class DuplicateConsumerError extends DatasetReadinessError {
  readonly consumerId: string;

  constructor(consumerId: string) {
    super(`consumer "${consumerId}" is already declared`);
    this.consumerId = consumerId;
  }
}

export class TaskNotFoundError extends DatasetReadinessError {
  readonly consumerId: string;

  constructor(consumerId: string) {
    super(`consumer "${consumerId}" is not declared`);
    this.consumerId = consumerId;
  }
}

export class TaskNotReadyError extends DatasetReadinessError {
  readonly consumerId: string;

  constructor(consumerId: string) {
    super(`consumer "${consumerId}" is not ready`);
    this.consumerId = consumerId;
  }
}

export class TaskUnregisteredError extends DatasetReadinessError {
  readonly consumerId: string;

  constructor(consumerId: string) {
    super(`consumer "${consumerId}" was unregistered`);
    this.consumerId = consumerId;
  }
}

export class AbortError extends DatasetReadinessError {
  constructor(message = "readiness wait was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

interface NormalizedRequirement {
  readonly dataset: string;
  readonly partitions: readonly string[];
  readonly partitionMode: ReadinessMode;
  readonly schemaHashes: ReadonlySet<string> | null;
}

interface NormalizedDeclaration {
  readonly mode: ReadinessMode;
  readonly requirements: readonly NormalizedRequirement[];
  readonly onReady?: (snapshot: ReadinessSnapshot) => void;
}

interface PartitionRecord {
  highestGeneration: number | undefined;
  publication: PublicationSnapshot | undefined;
}

interface Waiter {
  readonly resolve: (snapshot: ReadinessSnapshot) => void;
  readonly reject: (error: Error) => void;
  readonly signal: ReadinessAbortSignal | undefined;
  readonly onAbort: () => void;
}

interface InternalTask {
  readonly id: string;
  readonly declaration: NormalizedDeclaration;
  state: TaskState;
  snapshot: ReadinessSnapshot | undefined;
  triggerCount: number;
  readonly waiters: Waiter[];
}

interface TriggerRecord {
  readonly task: InternalTask;
  readonly snapshot: ReadinessSnapshot;
}

interface RefreshResult {
  readonly triggered: readonly TriggerRecord[];
  readonly updated: readonly string[];
  readonly transitions: readonly TaskTransition[];
}

type ErrorFactory = (message: string) => Error;

function readString(value: unknown, field: string, makeError: ErrorFactory): string {
  if (typeof value !== "string" || value.length === 0) {
    throw makeError(`${field} must be a non-empty string`);
  }
  if (value.includes("\u0000")) {
    throw makeError(`${field} must not contain a NUL character`);
  }
  return value;
}

function readOptionalString(value: unknown, field: string, makeError: ErrorFactory): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, field, makeError);
}

function readGeneration(value: unknown, field: string, makeError: ErrorFactory): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw makeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function readMode(value: unknown, field: string, makeError: ErrorFactory): ReadinessMode {
  if (value === "all" || value === "any") {
    return value;
  }
  throw makeError(`${field} must be "all" or "any"`);
}

function readStringList(value: unknown, field: string, makeError: ErrorFactory): string[] {
  if (!Array.isArray(value)) {
    throw makeError(`${field} must be an array of strings`);
  }
  const result: string[] = [];
  for (const item of value) {
    const text = readString(item, field, makeError);
    if (!result.includes(text)) {
      result.push(text);
    }
  }
  return result;
}

function normalizeRequirement(
  input: RequirementInput,
  label: string,
  makeError: ErrorFactory,
  defaultSchemaHashes: ReadonlySet<string> | null | undefined,
): NormalizedRequirement {
  const requirement: DatasetRequirement = typeof input === "string" ? { dataset: input } : input;
  if (requirement === null || typeof requirement !== "object") {
    throw makeError(`${label} must be a dataset name or an object`);
  }

  const dataset = readString(requirement.dataset, `${label}.dataset`, makeError);
  let partitions: string[];
  if (requirement.partitions === undefined) {
    partitions = ["*"];
  } else {
    partitions = readStringList(requirement.partitions, `${label}.partitions`, makeError);
    if (partitions.length === 0) {
      throw makeError(`${label}.partitions must not be empty`);
    }
  }

  const partitionMode = readMode(
    requirement.partitionMode ?? "all",
    `${label}.partitionMode`,
    makeError,
  );

  if (requirement.schemaHashes !== undefined && requirement.schemas !== undefined) {
    throw makeError(`${label} must use either schemaHashes or schemas, not both`);
  }
  const schemaInput = requirement.schemaHashes ?? requirement.schemas;
  let schemaHashes: ReadonlySet<string> | null;
  if (schemaInput !== undefined) {
    const values = readStringList(schemaInput, `${label}.schemaHashes`, makeError);
    schemaHashes = values.includes("*") ? null : new Set(values);
  } else {
    schemaHashes = defaultSchemaHashes === undefined ? null : defaultSchemaHashes;
  }

  return { dataset, partitions, partitionMode, schemaHashes };
}

function normalizeDeclaration(
  declaration: Omit<ConsumerDeclaration, "id">,
  id: string,
): NormalizedDeclaration {
  const makeError: ErrorFactory = (message) => new InvalidDeclarationError(message);
  if (declaration === null || typeof declaration !== "object") {
    throw makeError(`declaration for consumer "${id}" must be an object`);
  }
  if (!Array.isArray(declaration.requirements) || declaration.requirements.length === 0) {
    throw makeError(`consumer "${id}" must declare at least one requirement`);
  }
  if (declaration.onReady !== undefined && typeof declaration.onReady !== "function") {
    throw makeError(`consumer "${id}" onReady must be a function`);
  }

  const mode = readMode(declaration.mode ?? "all", `consumer "${id}" mode`, makeError);
  if (declaration.schemaHashes !== undefined && declaration.schemas !== undefined) {
    throw makeError(`consumer "${id}" must use either schemaHashes or schemas, not both`);
  }
  const defaultSchemaInput = declaration.schemaHashes ?? declaration.schemas;
  let defaultSchemaHashes: ReadonlySet<string> | null | undefined;
  if (defaultSchemaInput !== undefined) {
    const values = readStringList(
      defaultSchemaInput,
      `consumer "${id}" schemaHashes`,
      makeError,
    );
    defaultSchemaHashes = values.includes("*") ? null : new Set(values);
  }
  const requirements = declaration.requirements.map((requirement, index) =>
    normalizeRequirement(
      requirement,
      `consumer "${id}" requirements[${index}]`,
      makeError,
      defaultSchemaHashes,
    ),
  );

  return { mode, requirements, onReady: declaration.onReady };
}

function freezePublication(publication: PublicationSnapshot): PublicationSnapshot {
  const copy: PublicationSnapshot =
    publication.producer === undefined
      ? {
          dataset: publication.dataset,
          partition: publication.partition,
          schemaHash: publication.schemaHash,
          generation: publication.generation,
        }
      : {
          dataset: publication.dataset,
          partition: publication.partition,
          schemaHash: publication.schemaHash,
          generation: publication.generation,
          producer: publication.producer,
        };
  return Object.freeze(copy);
}

function freezeSnapshot(
  consumerId: string,
  mode: ReadinessMode,
  entries: readonly PublicationSnapshot[],
): ReadinessSnapshot {
  return Object.freeze({
    consumerId,
    mode,
    entries: Object.freeze([...entries]),
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function publicationKey(publication: PublicationSnapshot): string {
  return `${publication.dataset}\u0000${publication.partition}`;
}

function sameSnapshot(
  left: ReadinessSnapshot | undefined,
  right: ReadinessSnapshot | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.entries.length !== right.entries.length) return false;
  for (let index = 0; index < left.entries.length; index += 1) {
    const a = left.entries[index];
    const b = right.entries[index];
    if (
      a.dataset !== b.dataset ||
      a.partition !== b.partition ||
      a.schemaHash !== b.schemaHash ||
      a.generation !== b.generation ||
      a.producer !== b.producer
    ) {
      return false;
    }
  }
  return true;
}

export class DatasetReadinessCoordinator {
  private readonly publications = new Map<string, Map<string, PartitionRecord>>();
  private readonly tasks = new Map<string, InternalTask>();

  publish(signal: PublishSignal): SignalResult {
    const makeError: ErrorFactory = (message) => new InvalidSignalError(message);
    if (signal === null || typeof signal !== "object") {
      throw makeError("publish signal must be an object");
    }
    if (signal.type !== undefined && signal.type !== "publish") {
      throw makeError('publish signal type must be "publish"');
    }
    const dataset = readString(signal.dataset, "dataset", makeError);
    const partition = readString(signal.partition, "partition", makeError);
    const schemaHash = readString(signal.schemaHash, "schemaHash", makeError);
    const generation = readGeneration(signal.generation, "generation", makeError);
    const producer = readOptionalString(signal.producer, "producer", makeError);
    return this.applyPublish(dataset, partition, schemaHash, generation, producer);
  }

  withdraw(signal: WithdrawSignal): SignalResult {
    const makeError: ErrorFactory = (message) => new InvalidSignalError(message);
    if (signal === null || typeof signal !== "object") {
      throw makeError("withdraw signal must be an object");
    }
    if (signal.type !== undefined && signal.type !== "withdraw") {
      throw makeError('withdraw signal type must be "withdraw"');
    }
    const dataset = readString(signal.dataset, "dataset", makeError);
    const partition = readString(signal.partition, "partition", makeError);
    const generation = readGeneration(signal.generation, "generation", makeError);
    const schemaHash = readOptionalString(signal.schemaHash, "schemaHash", makeError);
    const producer = readOptionalString(signal.producer, "producer", makeError);
    return this.applyWithdraw(dataset, partition, generation, schemaHash, producer);
  }

  signal(signal: DatasetSignal): SignalResult {
    if (signal !== null && typeof signal === "object") {
      if (signal.type === "publish") {
        return this.publish(signal);
      }
      if (signal.type === "withdraw") {
        return this.withdraw(signal);
      }
    }
    throw new InvalidSignalError('signal type must be "publish" or "withdraw"');
  }

  declareConsumer(declaration: ConsumerDeclaration): ReadinessTaskHandle;
  declareConsumer(id: string, declaration: Omit<ConsumerDeclaration, "id">): ReadinessTaskHandle;
  declareConsumer(
    idOrDeclaration: string | ConsumerDeclaration,
    maybeDeclaration?: Omit<ConsumerDeclaration, "id">,
  ): ReadinessTaskHandle {
    const makeError: ErrorFactory = (message) => new InvalidDeclarationError(message);
    let id: string;
    let declaration: Omit<ConsumerDeclaration, "id">;

    if (typeof idOrDeclaration === "string") {
      id = readString(idOrDeclaration, "consumer id", makeError);
      if (maybeDeclaration === undefined) {
        throw makeError(`consumer "${id}" is missing a declaration`);
      }
      declaration = maybeDeclaration;
    } else {
      if (idOrDeclaration === null || typeof idOrDeclaration !== "object") {
        throw makeError("consumer declaration must be an object");
      }
      id = readString(idOrDeclaration.id, "consumer id", makeError);
      declaration = idOrDeclaration;
    }

    if (this.tasks.has(id)) {
      throw new DuplicateConsumerError(id);
    }

    const normalized = normalizeDeclaration(declaration, id);
    const task: InternalTask = {
      id,
      declaration: normalized,
      state: "waiting",
      snapshot: undefined,
      triggerCount: 0,
      waiters: [],
    };
    this.tasks.set(id, task);

    const initialSnapshot = this.evaluateTask(task);
    if (initialSnapshot !== undefined) {
      task.state = "ready";
      task.snapshot = initialSnapshot;
      task.triggerCount = 1;
      if (normalized.onReady !== undefined) {
        normalized.onReady(initialSnapshot);
      }
    }

    return new ReadinessTaskHandleImpl(this, id);
  }

  registerConsumer(declaration: ConsumerDeclaration): ReadinessTaskHandle;
  registerConsumer(id: string, declaration: Omit<ConsumerDeclaration, "id">): ReadinessTaskHandle;
  registerConsumer(
    idOrDeclaration: string | ConsumerDeclaration,
    maybeDeclaration?: Omit<ConsumerDeclaration, "id">,
  ): ReadinessTaskHandle {
    if (typeof idOrDeclaration === "string") {
      return this.declareConsumer(idOrDeclaration, maybeDeclaration as Omit<ConsumerDeclaration, "id">);
    }
    return this.declareConsumer(idOrDeclaration);
  }

  registerTask(declaration: ConsumerDeclaration): ReadinessTaskHandle;
  registerTask(id: string, declaration: Omit<ConsumerDeclaration, "id">): ReadinessTaskHandle;
  registerTask(
    idOrDeclaration: string | ConsumerDeclaration,
    maybeDeclaration?: Omit<ConsumerDeclaration, "id">,
  ): ReadinessTaskHandle {
    if (typeof idOrDeclaration === "string") {
      return this.declareConsumer(idOrDeclaration, maybeDeclaration as Omit<ConsumerDeclaration, "id">);
    }
    return this.declareConsumer(idOrDeclaration);
  }

  declareTask(declaration: ConsumerDeclaration): ReadinessTaskHandle;
  declareTask(id: string, declaration: Omit<ConsumerDeclaration, "id">): ReadinessTaskHandle;
  declareTask(
    idOrDeclaration: string | ConsumerDeclaration,
    maybeDeclaration?: Omit<ConsumerDeclaration, "id">,
  ): ReadinessTaskHandle {
    if (typeof idOrDeclaration === "string") {
      return this.declareConsumer(idOrDeclaration, maybeDeclaration as Omit<ConsumerDeclaration, "id">);
    }
    return this.declareConsumer(idOrDeclaration);
  }

  unregisterConsumer(id: string): boolean {
    const task = this.tasks.get(id);
    if (task === undefined) {
      return false;
    }
    this.tasks.delete(id);
    this.rejectWaiters(task, new TaskUnregisteredError(id));
    return true;
  }

  getTaskState(id: string): TaskState | undefined {
    return this.tasks.get(id)?.state;
  }

  inspectTask(id: string): TaskStatus | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) {
      return undefined;
    }
    return Object.freeze({
      id: task.id,
      state: task.state,
      triggerCount: task.triggerCount,
      snapshot: task.snapshot,
    });
  }

  listTasks(): readonly TaskStatus[] {
    const statuses: TaskStatus[] = [];
    for (const task of this.tasks.values()) {
      statuses.push(
        Object.freeze({
          id: task.id,
          state: task.state,
          triggerCount: task.triggerCount,
          snapshot: task.snapshot,
        }),
      );
    }
    return Object.freeze(statuses);
  }

  getSnapshot(id: string): ReadinessSnapshot | undefined {
    return this.tasks.get(id)?.snapshot;
  }

  getPublication(dataset: string, partition: string): PublicationSnapshot | undefined {
    return this.publications.get(dataset)?.get(partition)?.publication;
  }

  listPublications(dataset?: string): readonly PublicationSnapshot[] {
    const result: PublicationSnapshot[] = [];
    for (const [currentDataset, partitions] of this.publications) {
      if (dataset !== undefined && currentDataset !== dataset) {
        continue;
      }
      for (const record of partitions.values()) {
        if (record.publication !== undefined) {
          result.push(record.publication);
        }
      }
    }
    result.sort(
      (left, right) =>
        compareStrings(left.dataset, right.dataset) ||
        compareStrings(left.partition, right.partition),
    );
    return Object.freeze(result);
  }

  start(id: string): ReadinessSnapshot {
    const task = this.requireTask(id);
    if (task.state === "started") {
      return task.snapshot as ReadinessSnapshot;
    }
    if (task.state !== "ready" || task.snapshot === undefined) {
      throw new TaskNotReadyError(id);
    }
    task.state = "started";
    return task.snapshot;
  }

  tryStart(id: string): ReadinessSnapshot | null {
    const task = this.requireTask(id);
    if (task.state === "started") {
      return task.snapshot as ReadinessSnapshot;
    }
    if (task.state !== "ready" || task.snapshot === undefined) {
      return null;
    }
    task.state = "started";
    return task.snapshot;
  }

  waitForReady(id: string, options: WaitForReadyOptions = {}): Promise<ReadinessSnapshot> {
    const task = this.requireTask(id);
    if (task.state === "started") {
      return Promise.resolve(task.snapshot as ReadinessSnapshot);
    }
    if (task.state === "ready" && task.snapshot !== undefined) {
      return Promise.resolve(task.snapshot);
    }

    const signal = options.signal;
    if (signal?.aborted === true) {
      return Promise.reject(new AbortError());
    }

    return new Promise<ReadinessSnapshot>((resolve, reject) => {
      let waiter: Waiter;

      const onAbort = (): void => {
        const index = task.waiters.indexOf(waiter);
        if (index >= 0) {
          task.waiters.splice(index, 1);
        }
        signal?.removeEventListener("abort", onAbort);
        reject(new AbortError());
      };

      waiter = { resolve, reject, signal, onAbort };
      task.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort);
    });
  }

  reset(): void {
    for (const task of this.tasks.values()) {
      this.rejectWaiters(task, new TaskUnregisteredError(task.id));
    }
    this.tasks.clear();
    this.publications.clear();
  }

  private ensurePartition(dataset: string, partition: string): PartitionRecord {
    let partitions = this.publications.get(dataset);
    if (partitions === undefined) {
      partitions = new Map<string, PartitionRecord>();
      this.publications.set(dataset, partitions);
    }
    let record = partitions.get(partition);
    if (record === undefined) {
      record = { highestGeneration: undefined, publication: undefined };
      partitions.set(partition, record);
    }
    return record;
  }

  private applyPublish(
    dataset: string,
    partition: string,
    schemaHash: string,
    generation: number,
    producer: string | undefined,
  ): SignalResult {
    const record = this.ensurePartition(dataset, partition);
    const current = record.publication;

    if (record.highestGeneration !== undefined) {
      if (generation < record.highestGeneration) {
        return this.noop(
          "stale",
          dataset,
          partition,
          generation,
          `generation ${generation} is older than observed generation ${record.highestGeneration}`,
        );
      }
      if (generation === record.highestGeneration) {
        if (current !== undefined && current.generation === generation) {
          if (current.schemaHash === schemaHash && current.producer === producer) {
            return this.noop("duplicate", dataset, partition, generation, "publication already applied");
          }
          return this.noop(
            "conflict",
            dataset,
            partition,
            generation,
            "generation was already published with a different schema or producer",
          );
        }
        return this.noop(
          "stale",
          dataset,
          partition,
          generation,
          "generation was already withdrawn; publish a newer generation",
        );
      }
    }

    record.publication = freezePublication({
      dataset,
      partition,
      schemaHash,
      generation,
      ...(producer !== undefined ? { producer } : {}),
    });
    record.highestGeneration = generation;
    return this.finishSignal(dataset, partition, generation);
  }

  private applyWithdraw(
    dataset: string,
    partition: string,
    generation: number,
    schemaHash: string | undefined,
    producer: string | undefined,
  ): SignalResult {
    const record = this.publications.get(dataset)?.get(partition);
    if (record === undefined || record.highestGeneration === undefined) {
      return this.noop(
        "stale",
        dataset,
        partition,
        generation,
        "no publication has been observed for this partition",
      );
    }
    if (generation < record.highestGeneration) {
      return this.noop(
        "stale",
        dataset,
        partition,
        generation,
        `generation ${generation} is older than observed generation ${record.highestGeneration}`,
      );
    }
    if (generation > record.highestGeneration) {
      return this.noop(
        "stale",
        dataset,
        partition,
        generation,
        "generation has not been observed",
      );
    }

    const current = record.publication;
    if (current === undefined || current.generation !== generation) {
      return this.noop("duplicate", dataset, partition, generation, "generation is already withdrawn");
    }
    if (schemaHash !== undefined && current.schemaHash !== schemaHash) {
      return this.noop(
        "conflict",
        dataset,
        partition,
        generation,
        "withdraw schema does not match the current publication",
      );
    }
    if (producer !== undefined && current.producer !== producer) {
      return this.noop(
        "conflict",
        dataset,
        partition,
        generation,
        "withdraw producer does not match the current publication",
      );
    }

    record.publication = undefined;
    return this.finishSignal(dataset, partition, generation);
  }

  private finishSignal(dataset: string, partition: string, generation: number): SignalResult {
    const refresh = this.refreshTasks();
    let firstError: unknown;
    let hasError = false;

    for (const item of refresh.triggered) {
      this.resolveWaiters(item.task, item.snapshot);
      if (item.task.declaration.onReady !== undefined) {
        try {
          item.task.declaration.onReady(item.snapshot);
        } catch (error) {
          if (!hasError) {
            firstError = error;
            hasError = true;
          }
        }
      }
    }

    if (hasError) {
      throw firstError;
    }

    return Object.freeze({
      accepted: true,
      status: "applied",
      dataset,
      partition,
      generation,
      triggered: Object.freeze(refresh.triggered.map((item) => item.task.id)),
      updated: Object.freeze([...refresh.updated]),
      transitions: Object.freeze([...refresh.transitions]),
    });
  }

  private noop(
    status: Exclude<SignalStatus, "applied">,
    dataset: string,
    partition: string,
    generation: number,
    detail: string,
  ): SignalResult {
    return Object.freeze({
      accepted: false,
      status,
      dataset,
      partition,
      generation,
      triggered: Object.freeze([]),
      updated: Object.freeze([]),
      transitions: Object.freeze([]),
      detail,
    });
  }

  private refreshTasks(): RefreshResult {
    const triggered: TriggerRecord[] = [];
    const updated: string[] = [];
    const transitions: TaskTransition[] = [];

    for (const task of this.tasks.values()) {
      if (task.state === "started") {
        continue;
      }

      const next = this.evaluateTask(task);
      if (next === undefined) {
        if (task.state === "ready") {
          task.state = "waiting";
          task.snapshot = undefined;
          transitions.push(Object.freeze({ id: task.id, from: "ready", to: "waiting" }));
        }
        continue;
      }

      if (task.state === "waiting") {
        task.state = "ready";
        task.snapshot = next;
        task.triggerCount += 1;
        transitions.push(Object.freeze({ id: task.id, from: "waiting", to: "ready" }));
        triggered.push({ task, snapshot: next });
        continue;
      }

      if (!sameSnapshot(task.snapshot, next)) {
        task.snapshot = next;
        updated.push(task.id);
      }
    }

    return { triggered, updated, transitions };
  }

  private evaluateTask(task: InternalTask): ReadinessSnapshot | undefined {
    const declaration = task.declaration;
    const satisfied: PublicationSnapshot[][] = [];

    for (const requirement of declaration.requirements) {
      const entries = this.evaluateRequirement(requirement);
      if (entries === null) {
        if (declaration.mode === "all") {
          return undefined;
        }
        continue;
      }
      satisfied.push(entries);
    }

    if (declaration.mode === "any" && satisfied.length === 0) {
      return undefined;
    }

    const unique = new Map<string, PublicationSnapshot>();
    for (const group of satisfied) {
      for (const publication of group) {
        unique.set(publicationKey(publication), publication);
      }
    }

    const entries = [...unique.values()].sort(
      (left, right) =>
        compareStrings(left.dataset, right.dataset) ||
        compareStrings(left.partition, right.partition),
    );
    return freezeSnapshot(task.id, declaration.mode, entries);
  }

  private evaluateRequirement(requirement: NormalizedRequirement): PublicationSnapshot[] | null {
    const partitions = this.publications.get(requirement.dataset);
    if (partitions === undefined) {
      return null;
    }

    const live: PublicationSnapshot[] = [];
    const matches: PublicationSnapshot[] = [];
    for (const record of partitions.values()) {
      const publication = record.publication;
      if (publication !== undefined) {
        live.push(publication);
        if (this.schemaAllowed(requirement, publication.schemaHash)) {
          matches.push(publication);
        }
      }
    }
    live.sort((left, right) => compareStrings(left.partition, right.partition));
    matches.sort((left, right) => compareStrings(left.partition, right.partition));
    if (matches.length === 0) {
      return null;
    }

    if (requirement.partitionMode === "all") {
      const selected: PublicationSnapshot[] = [];
      for (const token of requirement.partitions) {
        if (token === "*") {
          if (live.length !== matches.length) {
            return null;
          }
          selected.push(...live);
          continue;
        }
        const match = matches.find((publication) => publication.partition === token);
        if (match === undefined) {
          return null;
        }
        selected.push(match);
      }
      return selected;
    }

    const selected: PublicationSnapshot[] = [];
    for (const token of requirement.partitions) {
      if (token === "*") {
        selected.push(...matches);
        continue;
      }
      const match = matches.find((publication) => publication.partition === token);
      if (match !== undefined) {
        selected.push(match);
      }
    }
    return selected.length === 0 ? null : selected;
  }

  private schemaAllowed(requirement: NormalizedRequirement, schemaHash: string): boolean {
    return requirement.schemaHashes === null || requirement.schemaHashes.has(schemaHash);
  }

  private requireTask(id: string): InternalTask {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new TaskNotFoundError(id);
    }
    return task;
  }

  private resolveWaiters(task: InternalTask, snapshot: ReadinessSnapshot): void {
    const waiters = task.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(snapshot);
    }
  }

  private rejectWaiters(task: InternalTask, error: Error): void {
    const waiters = task.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }
}

class ReadinessTaskHandleImpl implements ReadinessTaskHandle {
  readonly id: string;
  private readonly coordinator: DatasetReadinessCoordinator;

  constructor(coordinator: DatasetReadinessCoordinator, id: string) {
    this.coordinator = coordinator;
    this.id = id;
  }

  get state(): TaskState {
    const status = this.coordinator.inspectTask(this.id);
    if (status === undefined) {
      throw new TaskNotFoundError(this.id);
    }
    return status.state;
  }

  get triggerCount(): number {
    const status = this.coordinator.inspectTask(this.id);
    if (status === undefined) {
      throw new TaskNotFoundError(this.id);
    }
    return status.triggerCount;
  }

  snapshot(): ReadinessSnapshot | undefined {
    return this.coordinator.getSnapshot(this.id);
  }

  start(): ReadinessSnapshot {
    return this.coordinator.start(this.id);
  }

  tryStart(): ReadinessSnapshot | null {
    return this.coordinator.tryStart(this.id);
  }

  waitForReady(options?: WaitForReadyOptions): Promise<ReadinessSnapshot> {
    return this.coordinator.waitForReady(this.id, options);
  }

  unregister(): boolean {
    return this.coordinator.unregisterConsumer(this.id);
  }
}

export function createDatasetReadinessCoordinator(): DatasetReadinessCoordinator {
  return new DatasetReadinessCoordinator();
}

export const createReadinessCoordinator = createDatasetReadinessCoordinator;
export const createCoordinator = createDatasetReadinessCoordinator;

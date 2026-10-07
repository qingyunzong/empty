/**
 * gen-module-loader
 *
 * A module loading library with:
 *  - static linking of imports/exports (resolution happens before any code runs)
 *  - initialization ordered by dependency depth (deepest leaves first)
 *  - TDZ-style errors when reading uninitialized bindings
 *  - live bindings: importers always read the exporter's current value
 *  - cycles never re-execute a module body
 *  - failure propagation: a failed dependency fails its dependents without
 *    running their bodies
 *  - generational reset: reset() starts a new generation of module records,
 *    old (failed) records are kept untouched
 *  - an event trace plus an explicit, verifiable state machine
 */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const ModuleState = {
  Unlinked: "Unlinked",
  Linking: "Linking",
  Linked: "Linked",
  Evaluating: "Evaluating",
  Evaluated: "Evaluated",
  Failed: "Failed",
} as const;

export type ModuleState = (typeof ModuleState)[keyof typeof ModuleState];

/**
 * The complete, explicit transition table. Every state change in the loader
 * goes through `transition()` which validates against this table, and
 * `verifyTrace()` replays a trace against it.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<ModuleState, readonly ModuleState[]>> = {
  Unlinked: [ModuleState.Linking],
  Linking: [ModuleState.Linked, ModuleState.Failed],
  Linked: [ModuleState.Evaluating],
  Evaluating: [ModuleState.Evaluated, ModuleState.Failed],
  Evaluated: [],
  Failed: [],
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LoaderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Static linking failed: unknown module, missing export, or a dependency that failed to link. */
export class LinkError extends LoaderError {}

/** A binding was read before it was initialized (temporal dead zone). */
export class UninitializedBindingError extends LoaderError {}

/** A module could not evaluate because one of its dependencies failed. */
export class DependencyFailedError extends LoaderError {
  constructor(
    readonly module: string,
    readonly dependency: string,
    cause: unknown,
  ) {
    super(`module '${module}' cannot evaluate because dependency '${dependency}' failed`, { cause });
  }
}

/** An illegal state transition was attempted. */
export class InvalidTransitionError extends LoaderError {
  constructor(module: string, from: ModuleState, to: ModuleState) {
    super(`module '${module}': illegal transition ${from} -> ${to}`);
  }
}

// ---------------------------------------------------------------------------
// Bindings (live, TDZ-checked)
// ---------------------------------------------------------------------------

class Binding {
  #initialized = false;
  #value: unknown;

  constructor(
    readonly exportName: string,
    readonly owner: string,
  ) {}

  get initialized(): boolean {
    return this.#initialized;
  }

  get(): unknown {
    if (!this.#initialized) {
      throw new UninitializedBindingError(
        `cannot read '${this.exportName}' of module '${this.owner}' before it is initialized`,
      );
    }
    return this.#value;
  }

  set(value: unknown): void {
    this.#value = value;
    this.#initialized = true;
  }
}

// ---------------------------------------------------------------------------
// Module spec & runtime API
// ---------------------------------------------------------------------------

export interface ImportSpec {
  /** Name of the module to import from. */
  from: string;
  /** Name of the export in that module. Defaults to the local name. */
  export?: string;
}

export interface ModuleRuntime {
  /** Live read of an imported binding. Throws UninitializedBindingError in the TDZ. */
  import(local: string): unknown;
  /** Initialize or update one of this module's own exports. */
  export(name: string, value: unknown): void;
}

export type ModuleBody = (api: ModuleRuntime) => void;

export interface ModuleSpec {
  name: string;
  /** local name -> where it comes from */
  imports?: Record<string, ImportSpec>;
  /** names this module exports */
  exports?: string[];
  body: ModuleBody;
}

interface ResolvedImport {
  record: ModuleRecord;
  exportName: string;
}

// ---------------------------------------------------------------------------
// Module record (one per module per generation)
// ---------------------------------------------------------------------------

export class ModuleRecord {
  state: ModuleState = ModuleState.Unlinked;
  /** Dependency depth: 0 = no imports, otherwise 1 + max(dep depths). */
  depth = 0;
  /** The error that moved this record to Failed, if any. */
  error: unknown;
  readonly env = new Map<string, Binding>();
  readonly resolvedImports = new Map<string, ResolvedImport>();

  constructor(
    readonly spec: ModuleSpec,
    readonly generation: number,
  ) {
    for (const name of spec.exports ?? []) {
      this.env.set(name, new Binding(name, spec.name));
    }
  }

  get name(): string {
    return this.spec.name;
  }
}

// ---------------------------------------------------------------------------
// Event trace
// ---------------------------------------------------------------------------

export type TraceEventType =
  | "define"
  | "transition"
  | "evaluate:start"
  | "evaluate:success"
  | "evaluate:error"
  | "reset";

export interface TraceEvent {
  seq: number;
  generation: number;
  type: TraceEventType;
  module?: string;
  from?: ModuleState;
  to?: ModuleState;
  depth?: number;
  error?: string;
}

export interface TraceViolation {
  seq: number;
  message: string;
}

/**
 * Replays a trace against LEGAL_TRANSITIONS and returns every violation.
 * An empty array means the trace is a legal run of the state machine.
 */
export function verifyTrace(trace: readonly TraceEvent[]): TraceViolation[] {
  const violations: TraceViolation[] = [];
  const states = new Map<string, ModuleState>();
  for (const event of trace) {
    if (event.type !== "transition") continue;
    const key = `${event.generation}:${event.module ?? ""}`;
    const current = states.get(key) ?? ModuleState.Unlinked;
    const to = event.to as ModuleState;
    if (event.from !== current) {
      violations.push({
        seq: event.seq,
        message: `module '${event.module}' generation ${event.generation}: ` +
          `transition claims from=${event.from} but tracked state is ${current}`,
      });
    }
    if (!LEGAL_TRANSITIONS[current].includes(to)) {
      violations.push({
        seq: event.seq,
        message: `module '${event.module}' generation ${event.generation}: ` +
          `illegal transition ${current} -> ${to}`,
      });
    }
    states.set(key, to);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class Registry {
  #specs = new Map<string, ModuleSpec>();
  #records = new Map<string, ModuleRecord>();
  #generation = 0;
  #trace: TraceEvent[] = [];

  get generation(): number {
    return this.#generation;
  }

  /** Define a module. Its record starts Unlinked in the current generation. */
  define(spec: ModuleSpec): this {
    if (this.#specs.has(spec.name)) {
      throw new LoaderError(`module '${spec.name}' is already defined`);
    }
    this.#specs.set(spec.name, spec);
    this.#records.set(spec.name, new ModuleRecord(spec, this.#generation));
    this.#emit({ type: "define", module: spec.name });
    return this;
  }

  /** Current-generation record for a module. */
  record(name: string): ModuleRecord {
    const rec = this.#records.get(name);
    if (!rec) throw new LoaderError(`unknown module '${name}'`);
    return rec;
  }

  stateOf(name: string): ModuleState {
    return this.record(name).state;
  }

  /** Full event trace, in emission order. */
  trace(): readonly TraceEvent[] {
    return this.#trace;
  }

  // --- linking ------------------------------------------------------------

  /** Statically link one module (or every defined module when name is omitted). */
  link(name?: string): void {
    if (name !== undefined) {
      this.#linkRecord(this.record(name));
      return;
    }
    let firstError: unknown;
    for (const rec of this.#records.values()) {
      if (rec.state !== ModuleState.Unlinked) continue;
      try {
        this.#linkRecord(rec);
      } catch (err) {
        firstError ??= err;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  #linkRecord(rec: ModuleRecord): void {
    if (rec.state === ModuleState.Linked) return;
    if (rec.state === ModuleState.Linking) return; // cyclic back edge
    if (rec.state !== ModuleState.Unlinked) {
      throw new InvalidTransitionError(rec.name, rec.state, ModuleState.Linking);
    }
    this.#transition(rec, ModuleState.Linking);
    try {
      let depth = 0;
      for (const [local, spec] of Object.entries(rec.spec.imports ?? {})) {
        const dep = this.#records.get(spec.from);
        if (!dep) {
          throw new LinkError(`module '${rec.name}' imports from unknown module '${spec.from}'`);
        }
        this.#linkRecord(dep);
        const exportName = spec.export ?? local;
        if (!dep.env.has(exportName)) {
          throw new LinkError(`module '${dep.name}' does not export '${exportName}'`);
        }
        rec.resolvedImports.set(local, { record: dep, exportName });
        depth = Math.max(depth, dep.depth + 1);
      }
      rec.depth = depth;
      this.#transition(rec, ModuleState.Linked);
    } catch (err) {
      rec.error = err;
      this.#transition(rec, ModuleState.Failed, err);
      throw err;
    }
  }

  // --- evaluation ---------------------------------------------------------

  /** Evaluate one module, initializing dependencies deepest-first. */
  evaluate(name: string): void {
    this.#evaluateRecord(this.record(name));
  }

  /** Evaluate every linked module in ascending dependency-depth order. */
  evaluateAll(): void {
    const records = [...this.#records.values()].sort(
      (a, b) => a.depth - b.depth || (a.name < b.name ? -1 : 1),
    );
    const errors: unknown[] = [];
    for (const rec of records) {
      if (rec.state !== ModuleState.Linked) continue;
      try {
        this.#evaluateRecord(rec);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} module(s) failed to evaluate`);
    }
  }

  /** Convenience: link + evaluate a single module. */
  load(name: string): void {
    this.link(name);
    this.evaluate(name);
  }

  /** Convenience: link + evaluate everything. */
  loadAll(): void {
    this.link();
    this.evaluateAll();
  }

  #evaluateRecord(rec: ModuleRecord): void {
    if (rec.state === ModuleState.Evaluated) return;
    if (rec.state === ModuleState.Evaluating) return; // cycle: never re-execute
    if (rec.state === ModuleState.Failed) throw rec.error;
    if (rec.state !== ModuleState.Linked) {
      throw new InvalidTransitionError(rec.name, rec.state, ModuleState.Evaluating);
    }

    this.#transition(rec, ModuleState.Evaluating);
    this.#emit({ type: "evaluate:start", module: rec.name, depth: rec.depth });
    try {
      const deps = new Set<ModuleRecord>();
      for (const target of rec.resolvedImports.values()) deps.add(target.record);
      const ordered = [...deps].sort(
        (a, b) => a.depth - b.depth || (a.name < b.name ? -1 : 1),
      );
      for (const dep of ordered) {
        try {
          this.#evaluateRecord(dep);
        } catch (err) {
          throw new DependencyFailedError(rec.name, dep.name, err);
        }
      }
      rec.spec.body(this.#runtimeFor(rec));
      this.#transition(rec, ModuleState.Evaluated);
      this.#emit({ type: "evaluate:success", module: rec.name, depth: rec.depth });
    } catch (err) {
      rec.error = err;
      this.#transition(rec, ModuleState.Failed, err);
      this.#emit({
        type: "evaluate:error",
        module: rec.name,
        depth: rec.depth,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  #runtimeFor(rec: ModuleRecord): ModuleRuntime {
    return {
      import: (local: string): unknown => {
        const target = rec.resolvedImports.get(local);
        if (!target) {
          throw new LinkError(`module '${rec.name}' has no import named '${local}'`);
        }
        // Live binding: resolve through the exporter's environment on every read.
        return target.record.env.get(target.exportName)!.get();
      },
      export: (name: string, value: unknown): void => {
        const binding = rec.env.get(name);
        if (!binding) {
          throw new LinkError(`module '${rec.name}' does not declare export '${name}'`);
        }
        binding.set(value);
      },
    };
  }

  // --- namespace & reset ----------------------------------------------------

  /**
   * A namespace object whose properties are live getters over the module's
   * export bindings. Reading an uninitialized export throws.
   */
  namespace(name: string): Record<string, unknown> {
    const rec = this.record(name);
    const ns: Record<string, unknown> = {};
    for (const exportName of rec.env.keys()) {
      Object.defineProperty(ns, exportName, {
        enumerable: true,
        get: () => rec.env.get(exportName)!.get(),
      });
    }
    return ns;
  }

  /**
   * Start a new generation: every module gets a fresh Unlinked record.
   * Records (including Failed ones) from previous generations are untouched.
   */
  reset(): number {
    const from = this.#generation;
    this.#generation += 1;
    this.#records = new Map();
    for (const spec of this.#specs.values()) {
      this.#records.set(spec.name, new ModuleRecord(spec, this.#generation));
    }
    this.#emit({ type: "reset" });
    return this.#generation;
  }

  // --- internals ------------------------------------------------------------

  #transition(rec: ModuleRecord, to: ModuleState, error?: unknown): void {
    const from = rec.state;
    if (!LEGAL_TRANSITIONS[from].includes(to)) {
      throw new InvalidTransitionError(rec.name, from, to);
    }
    rec.state = to;
    this.#emit({
      type: "transition",
      module: rec.name,
      from,
      to,
      error: error instanceof Error ? error.message : undefined,
    });
  }

  #emit(event: Omit<TraceEvent, "seq" | "generation">): void {
    this.#trace.push({
      seq: this.#trace.length,
      generation: this.#generation,
      ...event,
    });
  }
}

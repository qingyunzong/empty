/**
 * modlink — a statically-linked module loader.
 *
 * Semantics modeled after ECMAScript modules:
 *  - Imports/exports are resolved statically at link time.
 *  - Imports are live bindings: reads go through to the exporter's slot.
 *  - Reading a binding before it is initialized throws (TDZ-like).
 *  - Modules are initialized in dependency-depth order (post-order DFS).
 *  - Cycles never re-execute a module.
 *  - Evaluation failures propagate to dependents and are terminal within
 *    a generation; reset() starts a new generation.
 */

export type ModuleState =
  | "unlinked"
  | "linking"
  | "linked"
  | "evaluating"
  | "evaluated"
  | "failed";

/** The explicit state machine: state -> set of legal successor states. */
export const STATE_MACHINE: Readonly<Record<ModuleState, readonly ModuleState[]>> = {
  unlinked: ["linking"],
  linking: ["linked", "failed"],
  linked: ["evaluating", "failed"],
  evaluating: ["evaluated", "failed"],
  evaluated: [],
  failed: [],
};

export function isValidTransition(from: ModuleState, to: ModuleState): boolean {
  return STATE_MACHINE[from].includes(to);
}

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

export class UninitializedBindingError extends ReferenceError {
  constructor(binding: string, owner: string, requester: string) {
    super(
      `Cannot read uninitialized binding '${binding}' of module '${owner}' (requested by '${requester}')`,
    );
    this.name = "UninitializedBindingError";
  }
}

export class ModuleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleStateError";
  }
}

export interface ImportDecl {
  from: string;
  names: string[];
}

export interface ReexportDecl {
  from: string;
  names: string[];
}

export interface EvalContext {
  /** Read an imported or own exported binding (live, TDZ-checked). */
  get(name: string): unknown;
  /** Initialize or update one of this module's own exported bindings. */
  set(name: string, value: unknown): void;
  /** The specifier of the module being evaluated. */
  readonly self: string;
}

export interface ModuleDefinition {
  imports?: ImportDecl[];
  reexports?: ReexportDecl[];
  exports?: string[];
  evaluate?: (ctx: EvalContext) => void;
}

export type TraceEventType = "define" | "reset" | "state" | "evaluate";

export interface TraceEvent {
  seq: number;
  generation: number;
  type: TraceEventType;
  module?: string;
  from?: ModuleState;
  to?: ModuleState;
  detail?: string;
}

interface BindingSlot {
  value: unknown;
  initialized: boolean;
}

interface ResolvedBinding {
  instance: ModuleInstance;
  slotName: string;
}

class ModuleInstance {
  state: ModuleState = "unlinked";
  error: unknown = undefined;
  depth = 0;
  /** Sequence number (per generation) at which evaluation finished. */
  evaluatedAt = -1;
  readonly slots = new Map<string, BindingSlot>();
  readonly resolvedImports = new Map<string, ResolvedBinding>();
  readonly dependencies: ModuleInstance[] = [];

  constructor(
    readonly loader: ModuleLoader,
    readonly specifier: string,
    readonly definition: ModuleDefinition,
    readonly generation: number,
  ) {}
}

export class ModuleLoader {
  /** Monotonic generation counter; reset() increments it. */
  generation = 0;
  /** Full event trace across all generations. */
  readonly trace: TraceEvent[] = [];

  private readonly definitions = new Map<string, ModuleDefinition>();
  private instances = new Map<string, ModuleInstance>();
  private seq = 0;
  private evalClock = 0;

  // ---------------------------------------------------------------- define

  define(specifier: string, definition: ModuleDefinition): this {
    if (this.definitions.has(specifier)) {
      throw new ModuleStateError(
        `module '${specifier}' is already defined in generation ${this.generation}; reset() before redefining`,
      );
    }
    this.definitions.set(specifier, definition);
    this.emit({ type: "define", module: specifier });
    return this;
  }

  // ------------------------------------------------------------------ link

  /** Statically link a module and its transitive dependencies. */
  link(specifier: string): void {
    this.linkInstance(this.getInstance(specifier));
  }

  private linkInstance(inst: ModuleInstance): void {
    if (inst.state !== "unlinked") return; // linking (cycle) or already linked
    this.transition(inst, "linking");
    try {
      const def = inst.definition;
      const depSpecifiers = [
        ...(def.imports ?? []).map((d) => d.from),
        ...(def.reexports ?? []).map((d) => d.from),
      ];
      for (const depSpec of depSpecifiers) {
        const dep = this.getInstance(depSpec);
        if (!inst.dependencies.includes(dep)) inst.dependencies.push(dep);
        this.linkInstance(dep);
        if (dep.state === "failed") throw dep.error;
      }
      // Create slots for own exports (uninitialized until evaluation).
      for (const name of def.exports ?? []) {
        inst.slots.set(name, { value: undefined, initialized: false });
      }
      // Resolve every imported name to the exporter's slot (live binding).
      for (const imp of def.imports ?? []) {
        const dep = this.getInstance(imp.from);
        for (const name of imp.names) {
          const resolved = this.resolveExport(dep, name, new Set());
          if (!resolved) {
            throw new LinkError(
              `module '${imp.from}' does not provide export '${name}' (imported by '${inst.specifier}')`,
            );
          }
          inst.resolvedImports.set(name, resolved);
        }
      }
      // Validate re-exports as well.
      for (const re of def.reexports ?? []) {
        const dep = this.getInstance(re.from);
        for (const name of re.names) {
          const resolved = this.resolveExport(dep, name, new Set());
          if (!resolved) {
            throw new LinkError(
              `module '${re.from}' does not provide export '${name}' (re-exported by '${inst.specifier}')`,
            );
          }
        }
      }
      // Dependency depth: 1 + max(depth of resolved deps); back edges ignored.
      let depth = 0;
      for (const dep of inst.dependencies) {
        if (dep.state !== "linking") depth = Math.max(depth, dep.depth + 1);
      }
      inst.depth = depth;
      this.transition(inst, "linked");
    } catch (err) {
      inst.error = err;
      this.transition(inst, "failed");
      throw err;
    }
  }

  private resolveExport(
    inst: ModuleInstance,
    name: string,
    seen: Set<ModuleInstance>,
  ): ResolvedBinding | null {
    if (seen.has(inst)) return null;
    seen.add(inst);
    if (inst.definition.exports?.includes(name)) {
      return { instance: inst, slotName: name };
    }
    let found: ResolvedBinding | null = null;
    for (const re of inst.definition.reexports ?? []) {
      if (!re.names.includes(name)) continue;
      const dep = this.getInstance(re.from);
      const candidate = this.resolveExport(dep, name, new Set(seen));
      if (!candidate) continue;
      if (
        found &&
        (found.instance !== candidate.instance || found.slotName !== candidate.slotName)
      ) {
        throw new LinkError(
          `ambiguous re-export '${name}' in module '${inst.specifier}'`,
        );
      }
      found = candidate;
    }
    return found;
  }

  // -------------------------------------------------------------- evaluate

  /**
   * Evaluate a module and its dependencies in dependency-depth order.
   * Each module body runs at most once per generation; failures propagate
   * to dependents and are terminal until reset().
   */
  evaluate(specifier: string): void {
    const inst = this.getInstance(specifier);
    if (inst.state === "unlinked") this.linkInstance(inst);
    this.evaluateInstance(inst);
  }

  private evaluateInstance(inst: ModuleInstance): void {
    if (inst.state === "evaluated") return;
    if (inst.state === "failed") throw inst.error; // terminal in this generation
    if (inst.state === "evaluating") return; // cycle: never re-execute
    if (inst.state === "unlinked") this.linkInstance(inst);

    // A failed dependency dooms a pending dependent without executing it.
    for (const dep of inst.dependencies) {
      if (dep.state === "failed") {
        inst.error = dep.error;
        this.transition(inst, "failed");
        throw inst.error;
      }
    }

    this.transition(inst, "evaluating");
    this.emit({ type: "evaluate", module: inst.specifier, detail: "start" });
    try {
      for (const dep of inst.dependencies) this.evaluateInstance(dep);
      inst.definition.evaluate?.(this.makeContext(inst));
      inst.evaluatedAt = this.evalClock++;
      this.transition(inst, "evaluated");
      this.emit({ type: "evaluate", module: inst.specifier, detail: "success" });
    } catch (err) {
      inst.error = err;
      this.transition(inst, "failed");
      this.emit({
        type: "evaluate",
        module: inst.specifier,
        detail: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
  }

  private makeContext(inst: ModuleInstance): EvalContext {
    const self = inst.specifier;
    return {
      self,
      get: (name: string): unknown => {
        const imported = inst.resolvedImports.get(name);
        if (imported) return this.readSlot(imported, self);
        const own = inst.slots.get(name);
        if (own) return this.readSlot({ instance: inst, slotName: name }, self);
        throw new LinkError(`module '${self}' has no binding named '${name}'`);
      },
      set: (name: string, value: unknown): void => {
        const slot = inst.slots.get(name);
        if (!slot) {
          throw new LinkError(
            `module '${self}' has no exported binding '${name}' to assign`,
          );
        }
        slot.value = value;
        slot.initialized = true;
      },
    };
  }

  private readSlot(resolved: ResolvedBinding, requester: string): unknown {
    const slot = resolved.instance.slots.get(resolved.slotName);
    if (!slot || !slot.initialized) {
      throw new UninitializedBindingError(
        resolved.slotName,
        resolved.instance.specifier,
        requester,
      );
    }
    return slot.value;
  }

  // ----------------------------------------------------------------- read

  /** Read an exported binding of a module (live, TDZ-checked). */
  read(specifier: string, name: string): unknown {
    const inst = this.getInstance(specifier);
    if (inst.state === "unlinked") this.linkInstance(inst);
    const resolved = this.resolveExport(inst, name, new Set());
    if (!resolved) {
      throw new LinkError(`module '${specifier}' does not provide export '${name}'`);
    }
    return this.readSlot(resolved, "<host>");
  }

  // ----------------------------------------------------------------- reset

  /**
   * Start a new generation: all instances (including failed ones) are
   * discarded; definitions are kept and will be re-instantiated lazily.
   */
  reset(): void {
    this.generation += 1;
    this.instances = new Map();
    this.evalClock = 0;
    this.emit({ type: "reset", detail: `generation ${this.generation}` });
  }

  // -------------------------------------------------------------- inspect

  stateOf(specifier: string): ModuleState {
    const inst = this.instances.get(specifier);
    if (!inst) {
      if (!this.definitions.has(specifier)) {
        throw new LinkError(`module '${specifier}' is not defined`);
      }
      return "unlinked";
    }
    return inst.state;
  }

  depthOf(specifier: string): number {
    return this.getInstance(specifier).depth;
  }

  /** Evaluation finish order within the current generation (-1 if not evaluated). */
  evaluationOrderOf(specifier: string): number {
    return this.getInstance(specifier).evaluatedAt;
  }

  /** State-transition events for one module, as `from->to` strings. */
  stateHistoryOf(specifier: string): string[] {
    return this.trace
      .filter((e) => e.type === "state" && e.module === specifier)
      .map((e) => `${e.from}->${e.to}`);
  }

  // -------------------------------------------------------------- internal

  private getInstance(specifier: string): ModuleInstance {
    let inst = this.instances.get(specifier);
    if (!inst) {
      const definition = this.definitions.get(specifier);
      if (!definition) {
        throw new LinkError(`module '${specifier}' is not defined`);
      }
      inst = new ModuleInstance(this, specifier, definition, this.generation);
      this.instances.set(specifier, inst);
    }
    return inst;
  }

  private transition(inst: ModuleInstance, to: ModuleState): void {
    const from = inst.state;
    if (!isValidTransition(from, to)) {
      throw new ModuleStateError(
        `illegal state transition ${from} -> ${to} for module '${inst.specifier}'`,
      );
    }
    inst.state = to;
    this.emit({ type: "state", module: inst.specifier, from, to });
  }

  private emit(event: Omit<TraceEvent, "seq" | "generation">): void {
    this.trace.push({ seq: this.seq++, generation: this.generation, ...event });
  }
}

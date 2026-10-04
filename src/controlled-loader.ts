import type { LoaderFn } from './loader.js';

export interface ModuleSpec {
  readonly deps?: readonly string[];
  readonly value?: unknown;
  readonly failTimes?: number;
  readonly error?: unknown;
  readonly gate?: Gate;
}

/** Manually released barrier to hold a module load pending. */
export class Gate {
  private release: (() => void) | undefined;
  private held: Promise<void> | undefined;

  hold(): void {
    if (this.held === undefined) {
      this.held = new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
  }

  open(): void {
    this.release?.();
    this.held = undefined;
    this.release = undefined;
  }

  wait(): Promise<void> {
    return this.held ?? Promise.resolve();
  }
}

/** Scriptable loader: per-module deps, values, failures and gates. */
export class ControlledLoader {
  private readonly specs = new Map<string, ModuleSpec>();
  private readonly remainingFailures = new Map<string, number>();
  private readonly calls = new Map<string, number>();

  define(id: string, spec: ModuleSpec = {}): this {
    this.specs.set(id, spec);
    this.remainingFailures.set(id, spec.failTimes ?? 0);
    return this;
  }

  callCount(id: string): number {
    return this.calls.get(id) ?? 0;
  }

  readonly load: LoaderFn = async (id, require) => {
    const spec = this.specs.get(id);
    if (spec === undefined) throw new Error(`unknown module: ${id}`);

    this.calls.set(id, this.callCount(id) + 1);

    const failures = this.remainingFailures.get(id) ?? 0;
    if (failures > 0) {
      this.remainingFailures.set(id, failures - 1);
      throw spec.error ?? new Error(`load failed: ${id}`);
    }

    await spec.gate?.wait();

    const deps = spec.deps ?? [];
    const depValues: Record<string, unknown> = {};
    await Promise.all(
      deps.map(async (dep) => {
        depValues[dep] = await require(dep);
      }),
    );

    if (spec.value !== undefined) return spec.value;
    return { id, deps: depValues };
  };
}

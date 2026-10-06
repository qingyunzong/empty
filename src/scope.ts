export interface ScopeHooks {
  onRead?(name: string, value: unknown): void;
  onWrite?(name: string, value: unknown): void;
}

/**
 * Variable environment. Reads/writes go through hooks so tests can
 * trace evaluation order with side effects.
 */
export class Scope {
  private readonly vars = new Map<string, unknown>();

  constructor(initial: Record<string, unknown> = {}, private readonly hooks: ScopeHooks = {}) {
    for (const [key, value] of Object.entries(initial)) this.vars.set(key, value);
  }

  has(name: string): boolean {
    return this.vars.has(name);
  }

  get(name: string): unknown {
    if (!this.vars.has(name)) throw new ReferenceError(`${name} is not defined`);
    const value = this.vars.get(name);
    this.hooks.onRead?.(name, value);
    return value;
  }

  set(name: string, value: unknown): void {
    this.hooks.onWrite?.(name, value);
    this.vars.set(name, value);
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.vars);
  }
}

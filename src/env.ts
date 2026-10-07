export class Env {
  private readonly vars = new Map<string, unknown>();
  readonly trace: string[] = [];

  static from(entries: Record<string, unknown>): Env {
    const env = new Env();
    for (const [name, value] of Object.entries(entries)) {
      env.vars.set(name, value);
    }
    return env;
  }

  log(entry: string): void {
    this.trace.push(entry);
  }

  define(name: string, value: unknown): void {
    this.vars.set(name, value);
  }

  has(name: string): boolean {
    return this.vars.has(name);
  }

  get(name: string): unknown {
    if (!this.vars.has(name)) {
      throw new ReferenceError(`${name} is not defined`);
    }
    return this.vars.get(name);
  }

  read(name: string): unknown {
    this.log(`read:${name}`);
    return this.get(name);
  }

  write(name: string, value: unknown): void {
    this.log(`write:${name}`);
    this.vars.set(name, value);
  }
}

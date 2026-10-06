import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PlanStep } from "./model.js";

export interface NameView {
  fold(name: string): string;
  has(abs: string): boolean;
  sameFile(a: string, b: string): boolean;
  resolveExisting(abs: string): string | null;
}

export class RealView implements NameView {
  readonly fold: (s: string) => string;
  constructor(fold: (s: string) => string) {
    this.fold = fold;
  }

  resolveExisting(abs: string): string | null {
    const dir = dirname(abs);
    const wanted = this.fold(basename(abs));
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (this.fold(entry) === wanted) return join(dir, entry);
    }
    return null;
  }

  has(abs: string): boolean {
    return this.resolveExisting(abs) !== null;
  }

  sameFile(a: string, b: string): boolean {
    try {
      const sa = statSync(a);
      const sb = statSync(b);
      return sa.dev === sb.dev && sa.ino === sb.ino;
    } catch {
      return false;
    }
  }
}

export class VirtualView implements NameView {
  private readonly names = new Map<string, string>();
  readonly fold: (s: string) => string;
  constructor(fold: (s: string) => string, initial: Iterable<string>) {
    this.fold = fold;
    for (const name of initial) this.names.set(fold(name), name);
  }

  private key(abs: string): string {
    return this.fold(abs);
  }

  has(abs: string): boolean {
    return this.names.has(this.key(abs));
  }

  sameFile(a: string, b: string): boolean {
    const ra = this.names.get(this.key(a));
    const rb = this.names.get(this.key(b));
    return ra !== undefined && ra === rb;
  }

  resolveExisting(abs: string): string | null {
    return this.names.get(this.key(abs)) ?? null;
  }

  rename(from: string, to: string): void {
    this.names.delete(this.key(from));
    this.names.set(this.key(to), to);
  }

  snapshot(): string[] {
    return [...this.names.keys()].sort();
  }
}

export type ReconcileResult =
  | { action: "skip" }
  | { action: "execute" }
  | { action: "mark-done" }
  | { problem: string };

export function consumedNames(steps: readonly PlanStep[], fold: (s: string) => string): Set<string> {
  return new Set(steps.map((s) => fold(s.from)));
}

export function reconcileStep(step: PlanStep, view: NameView, consumed?: Set<string>): ReconcileResult {
  const label = `step ${step.index} (${step.from} -> ${step.to})`;
  const fromExists = view.has(step.from);
  const toExists = view.has(step.to);
  const same = fromExists && toExists && view.sameFile(
    view.resolveExisting(step.from) ?? step.from,
    view.resolveExisting(step.to) ?? step.to,
  );

  switch (step.status) {
    case "done":
      if (toExists) return { action: "skip" };
      if (consumed?.has(view.fold(step.to))) return { action: "skip" };
      return { problem: `${label}: journal says done but filesystem disagrees` };
    case "doing":
      if (fromExists && (!toExists || same)) return { action: "execute" };
      if (!fromExists && toExists) return { action: "mark-done" };
      if (fromExists && toExists) {
        return { problem: `${label}: both endpoints exist; refusing to overwrite unknown file` };
      }
      return { problem: `${label}: both endpoints missing; filesystem changed externally` };
    case "pending":
      if (fromExists && (!toExists || same)) return { action: "execute" };
      if (fromExists && toExists) {
        return { problem: `${label}: unknown file at target; refusing to overwrite` };
      }
      if (!fromExists && toExists) {
        return { problem: `${label}: source vanished but target exists; filesystem changed externally` };
      }
      return { problem: `${label}: source missing; filesystem changed externally` };
  }
}

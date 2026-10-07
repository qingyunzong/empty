import type { Rational } from "./rational.ts";
import { parse as parseRational } from "./rational.ts";
import type { Sample } from "./enumerate.ts";
import { validateSamples } from "./enumerate.ts";

export function createDataset(entries: readonly { id: string; diff: Rational | string }[]): Sample[] {
  const samples: Sample[] = entries.map((e) => ({
    id: e.id,
    diff: typeof e.diff === "string" ? parseRational(e.diff) : e.diff,
  }));
  validateSamples(samples);
  return samples;
}

export function withdraw(samples: readonly Sample[], ids: readonly string[]): Sample[] {
  const drop = new Set(ids);
  const remaining = samples.filter((s) => !drop.has(s.id));
  validateSamples(remaining);
  return remaining;
}

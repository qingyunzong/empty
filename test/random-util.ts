import type { DeltaPackage, Problem } from "../src/model.js";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomProblem(rand: () => number): Problem {
  const versionCount = 2 + Math.floor(rand() * 5);
  const versions = Array.from({ length: versionCount }, (_, i) => `v${i}`);
  const packageCount = 1 + Math.floor(rand() * 10);
  const packages: DeltaPackage[] = [];
  const usedPairs = new Set<string>();
  for (let i = 0; i < packageCount; i += 1) {
    let from = versions[Math.floor(rand() * versionCount)];
    let to = versions[Math.floor(rand() * versionCount)];
    let guard = 0;
    while ((from === to || usedPairs.has(`${from}>${to}`)) && guard < 50) {
      from = versions[Math.floor(rand() * versionCount)];
      to = versions[Math.floor(rand() * versionCount)];
      guard += 1;
    }
    if (from === to || usedPairs.has(`${from}>${to}`)) continue;
    usedPairs.add(`${from}>${to}`);
    const bytes = rand() < 0.5 ? 5 + Math.floor(rand() * 3) * 5 : 1 + Math.floor(rand() * 40);
    packages.push({ id: `p${String(i).padStart(2, "0")}`, from, to, bytes });
  }
  const limitChoices = [8, 15, 25, 40, 1000];
  const spaceLimitBytes = limitChoices[Math.floor(rand() * limitChoices.length)];
  return {
    source: versions[0],
    target: versions[versionCount - 1],
    spaceLimitBytes,
    packages,
  };
}

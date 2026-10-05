export interface Version {
  readonly time: number;
  readonly origin: string;
}

export function compareVersion(a: Version, b: Version): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
}

export function maxVersion(a: Version, b: Version): Version {
  return compareVersion(a, b) >= 0 ? a : b;
}

export class LamportClock {
  private time = 0;

  constructor(private readonly replicaId: string) {}

  tick(): Version {
    this.time += 1;
    return { time: this.time, origin: this.replicaId };
  }

  witness(version: Version): void {
    if (version.time > this.time) this.time = version.time;
  }
}

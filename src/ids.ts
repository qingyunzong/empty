export interface OpId {
  counter: number;
  site: string;
}

export function compareOpIds(a: OpId, b: OpId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

export function sameOpId(a: OpId, b: OpId): boolean {
  return a.counter === b.counter && a.site === b.site;
}

export function formatOpId(id: OpId): string {
  return `${id.counter}@${id.site}`;
}

export function parseOpId(text: string): OpId {
  const at = text.indexOf("@");
  if (at <= 0 || at === text.length - 1) {
    throw new Error(`invalid op id: ${text}`);
  }
  const counter = Number(text.slice(0, at));
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(`invalid op id: ${text}`);
  }
  return { counter, site: text.slice(at + 1) };
}

export class LamportClock {
  private counter: number;

  constructor(readonly site: string, start = 0) {
    this.counter = start;
  }

  seen(id: OpId): void {
    if (id.counter > this.counter) this.counter = id.counter;
  }

  next(): OpId {
    this.counter += 1;
    return { counter: this.counter, site: this.site };
  }
}

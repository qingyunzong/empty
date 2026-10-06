import { HashAdapter } from './hash.js';
import { NodeConfig, Ring } from './ring.js';
import { RingBuilder } from './builder.js';

export class Cursor {
  private released = false;

  constructor(
    readonly ring: Ring,
    private readonly onRelease: () => void,
  ) {}

  get version(): number {
    return this.ring.version;
  }

  routeHash(keyHash: number): string | undefined {
    if (this.released) throw new Error('cursor has been released');
    return this.ring.ownerOfHash(keyHash);
  }

  route(key: string, adapter: HashAdapter): string | undefined {
    return this.routeHash(adapter.hash(key));
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease();
  }
}

export class Router {
  private ring: Ring = Ring.empty(0);
  private versionCounter = 0;
  private cursorCount = 0;

  constructor(private readonly builder: RingBuilder) {}

  get current(): Ring {
    return this.ring;
  }

  get activeCursors(): number {
    return this.cursorCount;
  }

  async publish(nodes: NodeConfig[]): Promise<Ring> {
    const version = ++this.versionCounter;
    const ring = await this.builder.build(nodes, version).promise;
    this.ring = ring;
    return ring;
  }

  acquireCursor(): Cursor {
    const ring = this.ring;
    this.cursorCount++;
    return new Cursor(ring, () => {
      this.cursorCount--;
    });
  }
}

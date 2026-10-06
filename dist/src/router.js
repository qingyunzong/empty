import { Ring } from './ring.js';
export class Cursor {
    ring;
    onRelease;
    released = false;
    constructor(ring, onRelease) {
        this.ring = ring;
        this.onRelease = onRelease;
    }
    get version() {
        return this.ring.version;
    }
    routeHash(keyHash) {
        if (this.released)
            throw new Error('cursor has been released');
        return this.ring.ownerOfHash(keyHash);
    }
    route(key, adapter) {
        return this.routeHash(adapter.hash(key));
    }
    release() {
        if (this.released)
            return;
        this.released = true;
        this.onRelease();
    }
}
export class Router {
    builder;
    ring = Ring.empty(0);
    versionCounter = 0;
    cursorCount = 0;
    constructor(builder) {
        this.builder = builder;
    }
    get current() {
        return this.ring;
    }
    get activeCursors() {
        return this.cursorCount;
    }
    async publish(nodes) {
        const version = ++this.versionCounter;
        const ring = await this.builder.build(nodes, version).promise;
        this.ring = ring;
        return ring;
    }
    acquireCursor() {
        const ring = this.ring;
        this.cursorCount++;
        return new Cursor(ring, () => {
            this.cursorCount--;
        });
    }
}

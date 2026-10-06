export class Fnv1aAdapter {
    hash(input) {
        return fnv1a(input);
    }
}
export function fnv1a(input) {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
export class SyncAsyncHashAdapter {
    inner;
    constructor(inner) {
        this.inner = inner;
    }
    hash(input) {
        return Promise.resolve(this.inner.hash(input));
    }
}

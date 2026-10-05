export function compareVersion(a, b) {
    if (a.time !== b.time)
        return a.time - b.time;
    return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
}
export function maxVersion(a, b) {
    return compareVersion(a, b) >= 0 ? a : b;
}
export class LamportClock {
    replicaId;
    time = 0;
    constructor(replicaId) {
        this.replicaId = replicaId;
    }
    tick() {
        this.time += 1;
        return { time: this.time, origin: this.replicaId };
    }
    witness(version) {
        if (version.time > this.time)
            this.time = version.time;
    }
}

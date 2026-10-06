function clone(state) {
    return {
        subs: state.subs.map((s) => ({ ...s })),
        nextId: state.nextId,
        nextSeq: state.nextSeq,
        version: state.version,
    };
}
export class RasterReference {
    state = { subs: [], nextId: 1, nextSeq: 0, version: 0 };
    undoStack = [];
    get version() {
        return this.state.version;
    }
    insert(layer, start, end, text = "") {
        this.undoStack.push(clone(this.state));
        this.state.version++;
        const id = this.state.nextId++;
        this.state.subs.push({ id, layer, start, end, text, seq: this.state.nextSeq++ });
        return id;
    }
    crop(id, start, end) {
        const sub = this.state.subs.find((s) => s.id === id);
        if (!sub)
            return false;
        this.undoStack.push(clone(this.state));
        this.state.version++;
        const newStart = Math.max(sub.start, start);
        const newEnd = Math.min(sub.end, end);
        if (newStart >= newEnd) {
            this.state.subs = this.state.subs.filter((s) => s.id !== id);
        }
        else {
            sub.start = newStart;
            sub.end = newEnd;
        }
        return true;
    }
    undo() {
        const prev = this.undoStack.pop();
        if (!prev)
            return false;
        this.state = prev;
        return true;
    }
    list() {
        return this.state.subs.map((s) => ({ ...s }));
    }
    /** 逐毫秒求可见者，再合并为最大连续段。 */
    visibleSegments() {
        if (this.state.subs.length === 0)
            return [];
        const maxEnd = Math.max(...this.state.subs.map((s) => s.end));
        const segments = [];
        for (let t = 0; t < maxEnd; t++) {
            const winner = this.winnerAt(t);
            if (!winner)
                continue;
            const last = segments[segments.length - 1];
            if (last && last.source === winner.id && last.end === t) {
                last.end = t + 1;
            }
            else {
                segments.push({
                    start: t,
                    end: t + 1,
                    source: winner.id,
                    layer: winner.layer,
                    text: winner.text,
                });
            }
        }
        return segments;
    }
    winnerAt(t) {
        let best = null;
        for (const sub of this.state.subs) {
            if (sub.start > t || t >= sub.end)
                continue;
            if (best === null ||
                sub.layer > best.layer ||
                (sub.layer === best.layer && sub.seq > best.seq)) {
                best = sub;
            }
        }
        return best;
    }
}

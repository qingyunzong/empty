import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export class InMemoryStore {
    map = new Map();
    get(key) {
        return this.map.get(key);
    }
    put(key, artifact) {
        this.map.set(key, artifact);
    }
    delete(key) {
        this.map.delete(key);
    }
    keys() {
        return [...this.map.keys()];
    }
}
/** JSON-file-backed store so old compile tasks can be resumed later. */
export class JsonFileStore {
    path;
    map;
    constructor(path) {
        this.path = path;
        this.map = new Map();
        if (existsSync(path)) {
            const raw = JSON.parse(readFileSync(path, "utf8"));
            for (const [k, v] of Object.entries(raw))
                this.map.set(k, v);
        }
    }
    get(key) {
        return this.map.get(key);
    }
    put(key, artifact) {
        this.map.set(key, artifact);
    }
    delete(key) {
        this.map.delete(key);
    }
    keys() {
        return [...this.map.keys()];
    }
    save() {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map), null, 2));
    }
}

// Persistent event store. Base facts only; derived propagation lives in the engine.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { InputError, validateEvent } from './event.js';

export class EventStore {
  constructor() {
    this.events = new Map();
  }

  add(raw) {
    const event = validateEvent(raw);
    if (this.events.has(event.id)) {
      throw new InputError(`duplicate event id: ${event.id}`);
    }
    this.events.set(event.id, event);
    return event;
  }

  retract(id) {
    if (!this.events.has(id)) {
      throw new InputError(`unknown event id: ${id}`);
    }
    this.events.delete(id);
  }

  has(id) {
    return this.events.has(id);
  }

  get(id) {
    return this.events.get(id);
  }

  list() {
    return [...this.events.values()];
  }

  static load(path) {
    const store = new EventStore();
    if (!existsSync(path)) return store;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new InputError(`bad JSON in store file: ${path}`);
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.events)) {
      throw new InputError(`bad store file (expected {"events":[...]}): ${path}`);
    }
    for (const raw of parsed.events) store.add(raw);
    return store;
  }

  save(path) {
    writeFileSync(path, JSON.stringify({ events: this.list() }, null, 2) + '\n');
  }
}

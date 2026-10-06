import { FieldError } from "./errors";
import { Value, isObjectId, validateValue } from "./values";

export class VMObject {
  readonly id: number;
  private readonly fieldsMap = new Map<string, Value>();

  constructor(id: number) {
    this.id = id;
  }

  getField(name: string): Value | undefined {
    return this.fieldsMap.get(name);
  }

  fieldNames(): string[] {
    return [...this.fieldsMap.keys()];
  }

  /** Internal: callers must validate via Heap.setField first. */
  writeField(name: string, value: Value): void {
    this.fieldsMap.set(name, value);
  }
}

/**
 * Object heap with stable ids. Every mutation validates before writing,
 * so a failed field write never modifies the heap.
 */
export class Heap {
  private objects = new Map<number, VMObject>();
  private nextId = 1;

  createObject(): VMObject {
    return this.createObjectWithId(this.nextId);
  }

  createObjectWithId(id: number): VMObject {
    if (!isObjectId(id)) {
      throw new FieldError(`invalid object id ${String(id)}`);
    }
    if (this.objects.has(id)) {
      throw new FieldError(`object id #${id} already exists`);
    }
    const obj = new VMObject(id);
    this.objects.set(id, obj);
    if (id >= this.nextId) {
      this.nextId = id + 1;
    }
    return obj;
  }

  hasObject(id: number): boolean {
    return this.objects.has(id);
  }

  getObject(id: number): VMObject {
    const obj = this.objects.get(id);
    if (obj === undefined) {
      throw new FieldError(`no object with id #${id}`);
    }
    return obj;
  }

  objectIds(): number[] {
    return [...this.objects.keys()].sort((a, b) => a - b);
  }

  get size(): number {
    return this.objects.size;
  }

  /**
   * Validates the value fully, then writes. On any validation failure the
   * heap is left untouched (no partial field state).
   */
  setField(target: number | VMObject, name: string, value: Value): void {
    const obj = typeof target === "number" ? this.getObject(target) : target;
    if (typeof name !== "string" || name.length === 0) {
      throw new FieldError("field name must be a non-empty string");
    }
    const problem = validateValue(value, (id) => this.objects.has(id));
    if (problem !== null) {
      throw new FieldError(`field "${name}" on object #${obj.id}: ${problem}`);
    }
    obj.writeField(name, value);
  }

  getField(target: number | VMObject, name: string): Value | undefined {
    const obj = typeof target === "number" ? this.getObject(target) : target;
    return obj.getField(name);
  }

  fieldNames(target: number | VMObject): string[] {
    const obj = typeof target === "number" ? this.getObject(target) : target;
    return obj.fieldNames();
  }

  /** Atomically replaces this heap's contents with another heap's state. */
  adoptFrom(source: Heap): void {
    this.objects = new Map(source.objects);
    this.nextId = source.nextId;
  }

  /** Id the next created object will receive. */
  get peekNextId(): number {
    return this.nextId;
  }
}

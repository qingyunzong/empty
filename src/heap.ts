import { BadReferenceError, ValidationError } from "./errors.js";
import type { Value } from "./values.js";

export interface HeapObject {
  readonly id: number;
  readonly fields: Map<string, Value>;
}

/** 虚拟机堆:按稳定对象 ID 存放对象及其字段。 */
export class Heap {
  #objects = new Map<number, HeapObject>();
  #nextId = 1;

  get size(): number {
    return this.#objects.size;
  }

  has(id: number): boolean {
    return this.#objects.has(id);
  }

  get(id: number): HeapObject | undefined {
    return this.#objects.get(id);
  }

  require(id: number): HeapObject {
    const obj = this.#objects.get(id);
    if (!obj) throw new BadReferenceError(`no object with id ${id}`);
    return obj;
  }

  objectIds(): number[] {
    return [...this.#objects.keys()].sort((a, b) => a - b);
  }

  objects(): HeapObject[] {
    return this.objectIds().map((id) => this.require(id));
  }

  /** 分配对象;可指定稳定 ID,否则自增分配。 */
  allocate(id?: number): HeapObject {
    let oid: number;
    if (id === undefined) {
      oid = this.#nextId;
    } else {
      if (!Number.isSafeInteger(id) || id < 1) {
        throw new ValidationError(`invalid object id: ${id}`);
      }
      if (this.#objects.has(id)) {
        throw new ValidationError(`duplicate object id: ${id}`);
      }
      oid = id;
    }
    const obj: HeapObject = { id: oid, fields: new Map() };
    this.#objects.set(oid, obj);
    if (oid >= this.#nextId) this.#nextId = oid + 1;
    return obj;
  }

  /**
   * 写字段。先完整校验再写入:任何字段级故障(非法值、悬空引用)
   * 都会抛出异常且不改堆,保证旧堆不被污染。
   */
  setField(id: number, name: string, value: Value): void {
    const obj = this.require(id);
    if (typeof name !== "string" || name.length === 0) {
      throw new ValidationError("field name must be a non-empty string");
    }
    switch (value.kind) {
      case "int":
        if (!Number.isSafeInteger(value.value)) {
          throw new ValidationError(`field "${name}": not a safe integer`);
        }
        break;
      case "bytes":
        if (!(value.value instanceof Uint8Array)) {
          throw new ValidationError(`field "${name}": bytes must be a Uint8Array`);
        }
        break;
      case "ref":
        if (!this.#objects.has(value.id)) {
          throw new BadReferenceError(
            `field "${name}" on object ${id} references missing object ${value.id}`
          );
        }
        break;
      default:
        throw new ValidationError(`field "${name}": unknown value kind`);
    }
    obj.fields.set(name, value);
  }

  getField(id: number, name: string): Value | undefined {
    return this.require(id).fields.get(name);
  }
}

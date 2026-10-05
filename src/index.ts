import { parse } from './parser';
import { Path, deleteItem, formatPath, getNode, setScalar, toJS } from './edit';

export { parse, ParseError } from './parser';
export type {
  AnyNode,
  Document,
  LineInfo,
  MapEntry,
  MapNode,
  ScalarNode,
  ScalarValue,
  SeqItem,
  SeqNode,
  Span,
} from './parser';
export { deleteItem, formatPath, getNode, getValue, serializeScalar, setScalar, toJS } from './edit';
export type { Path } from './edit';

/** Stateful wrapper: each mutation re-parses so spans stay exact. */
export class Config {
  private text: string;

  private constructor(text: string) {
    this.text = text;
  }

  static parse(text: string): Config {
    parse(text); // validate eagerly
    return new Config(text);
  }

  has(path: Path): boolean {
    return getNode(parse(this.text), path) !== null;
  }

  get(path: Path): unknown {
    const node = getNode(parse(this.text), path);
    return node === null ? undefined : toJS(node);
  }

  /** Returns false (without modifying) when the path does not exist. */
  set(path: Path, value: unknown): boolean {
    const node = getNode(parse(this.text), path);
    if (node === null) return false;
    if (node.kind !== 'scalar') {
      throw new Error(`cannot set scalar at ${formatPath(path)}: target is a ${node.kind}`);
    }
    this.text = setScalar(this.text, path, value);
    return true;
  }

  /** Returns false (without modifying) when the path does not exist. */
  delete(path: Path): boolean {
    const next = deleteItem(this.text, path);
    if (next === this.text) return false;
    this.text = next;
    return true;
  }

  toJS(): unknown {
    return toJS(parse(this.text).root);
  }

  toString(): string {
    return this.text;
  }
}

import type {
  Diagnostic,
  ElementNode,
  Node,
  ParserEvent,
  RootNode,
  TextEvent,
} from './types.js';

/** 预览解析器支持的标签。 */
export const SUPPORTED_TAGS: ReadonlySet<string> = new Set(['p', 'b', 'i', 'br']);
/** 空元素（不需要闭合标签）。 */
export const VOID_TAGS: ReadonlySet<string> = new Set(['br']);

interface StackEntry {
  node: ElementNode;
  /** 起始标签的结束偏移，用于诊断定位。 */
  openEnd: number;
}

/**
 * 树构建器：独立地消费词法事件流并施加结构规则——
 * - 只支持 p / b / i / br 与文本，其余标签忽略并报告 unknown-tag；
 * - p 内出现新的 p 时隐式结束旧的 p（顺带隐式关闭其内联元素）；
 * - 闭合不存在的标签忽略并报告 unmatched-close；
 * - 闭合非栈顶元素时，其上的元素隐式关闭并报告 implicit-close；
 * - 输入结束时仍未闭合的元素报告 unclosed-tag（按弹栈顺序，自内向外）。
 */
export class TreeBuilder {
  readonly root: RootNode = { type: 'root', children: [], start: 0, end: 0 };
  private stack: StackEntry[] = [];

  constructor(private readonly report: (diagnostic: Diagnostic) => void) {}

  handleEvent(event: ParserEvent): void {
    switch (event.type) {
      case 'text':
        this.appendText(event);
        break;
      case 'open':
        this.openElement(event);
        break;
      case 'close':
        this.closeElement(event);
        break;
    }
  }

  finish(end: number): RootNode {
    while (this.stack.length > 0) {
      const entry = this.stack.pop()!;
      entry.node.end = end;
      this.report({
        code: 'unclosed-tag',
        message: `Element <${entry.node.name}> was never closed`,
        start: entry.node.start,
        end: entry.openEnd,
      });
    }
    this.root.end = end;
    return this.root;
  }

  private currentChildren(): Node[] {
    const top = this.stack[this.stack.length - 1];
    return top ? top.node.children : this.root.children;
  }

  private appendText(event: TextEvent): void {
    const children = this.currentChildren();
    const last = children[children.length - 1];
    if (last && last.type === 'text') {
      last.text += event.text;
      last.segments.push(...event.segments);
      last.end = event.end;
    } else {
      children.push({
        type: 'text',
        text: event.text,
        segments: [...event.segments],
        start: event.start,
        end: event.end,
      });
    }
  }

  private openElement(event: ParserEvent & { type: 'open' }): void {
    const { name } = event;
    if (!SUPPORTED_TAGS.has(name)) {
      this.report({
        code: 'unknown-tag',
        message: `Unsupported tag <${name}> ignored`,
        start: event.start,
        end: event.end,
      });
      return;
    }
    if (name === 'p') {
      const idx = this.stack.findIndex((entry) => entry.node.name === 'p');
      if (idx !== -1) {
        // p 内的新 p 隐式结束旧的 p（其上的内联元素记 implicit-close）
        this.popImplicitAbove(idx);
        this.stack.pop()!.node.end = event.start;
      }
    }
    const node: ElementNode = {
      type: 'element',
      name,
      children: [],
      start: event.start,
      end: event.end,
    };
    this.currentChildren().push(node);
    if (!VOID_TAGS.has(name)) {
      this.stack.push({ node, openEnd: event.end });
    }
  }

  private closeElement(event: ParserEvent & { type: 'close' }): void {
    const { name } = event;
    if (!SUPPORTED_TAGS.has(name)) {
      this.report({
        code: 'unknown-tag',
        message: `Unsupported tag </${name}> ignored`,
        start: event.start,
        end: event.end,
      });
      return;
    }
    let idx = -1;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]!.node.name === name) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      this.report({
        code: 'unmatched-close',
        message: `Closing tag </${name}> has no matching open tag, ignored`,
        start: event.start,
        end: event.end,
      });
      return;
    }
    this.popImplicitAbove(idx);
    this.stack.pop()!.node.end = event.end;
  }

  /** 隐式关闭栈中 idx 之上的元素（不含 idx 本身）。 */
  private popImplicitAbove(idx: number): void {
    while (this.stack.length - 1 > idx) {
      const entry = this.stack.pop()!;
      this.report({
        code: 'implicit-close',
        message: `Element <${entry.node.name}> implicitly closed`,
        start: entry.node.start,
        end: entry.openEnd,
      });
    }
  }
}

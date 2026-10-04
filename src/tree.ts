import type { Diagnostic, EntityRef, ParserEvent, TagName } from "./parser.js";

export interface RootNode {
  type: "root";
  children: TreeNode[];
}

export interface ElementNode {
  type: "element";
  tag: TagName;
  /** Absolute offset of the open tag. */
  start: number;
  /** Absolute offset just past the close tag, or null when implicit. */
  end: number | null;
  children: TreeNode[];
}

export interface TextNode {
  type: "text";
  /** Decoded text content. */
  text: string;
  /** Absolute offset of the first raw source character. */
  start: number;
  /** Absolute offset just past the last raw source character. */
  end: number;
  /** Raw source ranges of every decoded entity, in order. */
  entities: EntityRef[];
}

export type TreeNode = ElementNode | TextNode;

export interface TreeResult {
  root: RootNode;
  /** Diagnostics in the exact order they were reported. */
  diagnostics: Diagnostic[];
}

/**
 * Builds a tree from a parser event stream. Adjacent text events are merged
 * only when their raw source ranges are contiguous, so byte mappings stay
 * exact.
 */
export function buildTree(events: ParserEvent[]): TreeResult {
  const root: RootNode = { type: "root", children: [] };
  const stack: Array<RootNode | ElementNode> = [root];
  const diagnostics: Diagnostic[] = [];

  for (const event of events) {
    const top = stack[stack.length - 1] as RootNode | ElementNode;
    switch (event.type) {
      case "open": {
        const node: ElementNode = {
          type: "element",
          tag: event.tag,
          start: event.start,
          end: null,
          children: [],
        };
        top.children.push(node);
        stack.push(node);
        break;
      }
      case "close": {
        for (let i = stack.length - 1; i >= 1; i--) {
          const node = stack[i] as ElementNode;
          if (node.tag === event.tag) {
            node.end = event.end;
            stack.length = i;
            break;
          }
        }
        break;
      }
      case "text": {
        const last = top.children[top.children.length - 1];
        if (last && last.type === "text" && last.end === event.start) {
          last.text += event.text;
          last.end = event.end;
          last.entities.push(...event.entities);
        } else {
          top.children.push({
            type: "text",
            text: event.text,
            start: event.start,
            end: event.end,
            entities: [...event.entities],
          });
        }
        break;
      }
      case "diagnostic": {
        diagnostics.push({
          offset: event.offset,
          code: event.code,
          message: event.message,
        });
        break;
      }
    }
  }
  return { root, diagnostics };
}

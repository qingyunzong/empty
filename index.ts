export type TreeVersion = string | number;

export interface ContainerNode {
  readonly type: "container";
  readonly id: string;
  readonly children: readonly RichNode[];
}

export interface TextNode {
  readonly type: "text";
  readonly id: string;
  readonly value: string;
}

export interface BreakNode {
  readonly type: "br";
  readonly id: string;
}

export interface AtomicNode {
  readonly type: "atom" | "atomic";
  readonly id: string;
}

export type RichNode = ContainerNode | TextNode | BreakNode | AtomicNode;

export interface Snapshot {
  readonly version: TreeVersion;
  readonly root: ContainerNode;
}

export interface Anchor {
  readonly nodeId: string;
  readonly offset: number;
}

export interface ReplaceRequest {
  readonly start: Anchor;
  readonly end: Anchor;
  readonly text: string;
}

export interface ReplaceOptions {
  readonly expectedVersion: TreeVersion;
  readonly generateId: () => string;
}

export interface CharacterOrigin {
  readonly newOffset: number;
  readonly oldOffset: number;
}

export interface ReplaceResult {
  readonly snapshot: Snapshot;
  readonly tree: ContainerNode;
  readonly cursor: Anchor;
  readonly normalizedRange: {
    readonly start: number;
    readonly end: number;
  };
  /**
   * Indexed by UTF-16 offset in the edited logical string. Retained characters
   * contain their original logical offset; inserted characters contain null.
   */
  readonly mapping: readonly (number | null)[];
  /**
   * The non-null entries of `mapping`, in document order.
   */
  readonly retainedCharacters: readonly CharacterOrigin[];
}

export type RangeEditErrorCode =
  | "INVALID_SNAPSHOT"
  | "INVALID_REQUEST"
  | "VERSION_MISMATCH"
  | "INVALID_ANCHOR"
  | "SPLIT_SURROGATE"
  | "UNORDERED_RANGE"
  | "ATOM_IN_RANGE"
  | "INVALID_TEXT"
  | "INVALID_ID"
  | "ID_COLLISION"
  | "ID_GENERATION_FAILED";

export class RangeEditError extends Error {
  readonly code: RangeEditErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RangeEditErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RangeEditError";
    this.code = code;
    this.details = details;
  }
}

export const ATOMIC_CHARACTER = "\uFFFC";
export const BREAK_CHARACTER = "\n";

interface ContainerInfo {
  readonly node: ContainerNode;
  readonly parentId: string | null;
  readonly start: number;
  readonly end: number;
  readonly gaps: readonly number[];
}

interface TextInfo {
  readonly node: TextNode;
  readonly parentId: string | null;
  readonly start: number;
  readonly end: number;
}

interface BreakInfo {
  readonly node: BreakNode;
  readonly parentId: string | null;
  readonly start: number;
  readonly end: number;
}

interface AtomicInfo {
  readonly node: AtomicNode;
  readonly parentId: string | null;
  readonly start: number;
  readonly end: number;
}

type NodeInfo = ContainerInfo | TextInfo | BreakInfo | AtomicInfo;

interface TreeIndex {
  readonly infos: ReadonlyMap<string, NodeInfo>;
  readonly logicalText: string;
  readonly length: number;
}

interface TextLocation {
  readonly kind: "text";
  readonly info: TextInfo;
  readonly offset: number;
  readonly position: number;
}

interface ContainerLocation {
  readonly kind: "container";
  readonly info: ContainerInfo;
  readonly offset: number;
  readonly position: number;
}

type AnchorLocation = TextLocation | ContainerLocation;

function isNodeObject(value: unknown): value is RichNode {
  return typeof value === "object" && value !== null;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }

      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }

      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function invalidSnapshot(message: string, details: Record<string, unknown> = {}): never {
  throw new RangeEditError("INVALID_SNAPSHOT", message, details);
}

function indexTree(snapshot: Snapshot): TreeIndex {
  if (typeof snapshot !== "object" || snapshot === null) {
    invalidSnapshot("Snapshot must be an object.");
  }

  if (typeof snapshot.version !== "string" && typeof snapshot.version !== "number") {
    invalidSnapshot("Snapshot version must be a string or number.");
  }

  const root = snapshot.root;
  if (!isNodeObject(root) || root.type !== "container") {
    invalidSnapshot("Snapshot root must be a container node.");
  }

  const infos = new Map<string, NodeInfo>();
  const parts: string[] = [];
  const seenIds = new Set<string>();
  const seenNodes = new Set<RichNode>();

  const visit = (node: RichNode, parentId: string | null, start: number): NodeInfo => {
    if (!isNodeObject(node)) {
      invalidSnapshot("Tree contains a non-object node.", { parentId });
    }

    if (typeof node.id !== "string" || node.id.length === 0) {
      invalidSnapshot("Every node must have a non-empty string ID.", {
        parentId,
        nodeType: node.type,
      });
    }

    if (seenNodes.has(node)) {
      invalidSnapshot("Tree contains a cycle or a node with multiple parents.", {
        nodeId: node.id,
      });
    }

    if (seenIds.has(node.id)) {
      invalidSnapshot("Node IDs must be unique.", { nodeId: node.id });
    }

    seenNodes.add(node);
    seenIds.add(node.id);

    switch (node.type) {
      case "container": {
        if (!Array.isArray(node.children)) {
          invalidSnapshot("Container children must be an array.", { nodeId: node.id });
        }

        const gaps: number[] = [start];
        let position = start;

        for (const child of node.children) {
          const childInfo = visit(child, node.id, position);
          position = childInfo.end;
          gaps.push(position);
        }

        const info: ContainerInfo = {
          node,
          parentId,
          start,
          end: position,
          gaps,
        };
        infos.set(node.id, info);
        return info;
      }

      case "text": {
        if (typeof node.value !== "string") {
          invalidSnapshot("Text node value must be a string.", { nodeId: node.id });
        }

        if (!isWellFormedUnicode(node.value)) {
          invalidSnapshot("Text node contains an unpaired UTF-16 surrogate.", {
            nodeId: node.id,
          });
        }

        const info: TextInfo = {
          node,
          parentId,
          start,
          end: start + node.value.length,
        };
        parts.push(node.value);
        infos.set(node.id, info);
        return info;
      }

      case "br": {
        const info: BreakInfo = {
          node,
          parentId,
          start,
          end: start + BREAK_CHARACTER.length,
        };
        parts.push(BREAK_CHARACTER);
        infos.set(node.id, info);
        return info;
      }

      case "atom":
      case "atomic": {
        const info: AtomicInfo = {
          node,
          parentId,
          start,
          end: start + ATOMIC_CHARACTER.length,
        };
        parts.push(ATOMIC_CHARACTER);
        infos.set(node.id, info);
        return info;
      }

      default:
        return invalidSnapshot("Unknown node type.", {
          nodeId: (node as { id?: unknown }).id,
          nodeType: (node as { type?: unknown }).type,
        });
    }
  };

  visit(root, null, 0);
  const logicalText = parts.join("");

  return {
    infos,
    logicalText,
    length: logicalText.length,
  };
}

export function getLogicalText(root: RichNode): string {
  if (!isNodeObject(root)) {
    throw new RangeEditError("INVALID_SNAPSHOT", "Root must be a node.");
  }

  const parts: string[] = [];

  const append = (node: RichNode): void => {
    if (!isNodeObject(node)) {
      throw new RangeEditError("INVALID_SNAPSHOT", "Tree contains a non-object node.");
    }

    switch (node.type) {
      case "container":
        for (const child of node.children) {
          append(child);
        }
        break;
      case "text":
        parts.push(node.value);
        break;
      case "br":
        parts.push(BREAK_CHARACTER);
        break;
      case "atom":
      case "atomic":
        parts.push(ATOMIC_CHARACTER);
        break;
      default:
        throw new RangeEditError("INVALID_SNAPSHOT", "Unknown node type.");
    }
  };

  append(root);
  return parts.join("");
}

export const serializeLogicalText = getLogicalText;

function resolvesToSurrogateSplit(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) {
    return false;
  }

  const before = value.charCodeAt(offset - 1);
  const at = value.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

function resolveAnchor(anchor: Anchor, index: TreeIndex, label: "start" | "end"): AnchorLocation {
  if (typeof anchor !== "object" || anchor === null) {
    throw new RangeEditError("INVALID_ANCHOR", `${label} anchor must be an object.`, {
      label,
    });
  }

  if (typeof anchor.nodeId !== "string" || anchor.nodeId.length === 0) {
    throw new RangeEditError("INVALID_ANCHOR", `${label} anchor has an invalid node ID.`, {
      label,
      nodeId: anchor.nodeId,
    });
  }

  const info = index.infos.get(anchor.nodeId);
  if (info === undefined) {
    throw new RangeEditError("INVALID_ANCHOR", `${label} anchor node does not exist.`, {
      label,
      nodeId: anchor.nodeId,
    });
  }

  if (!Number.isInteger(anchor.offset)) {
    throw new RangeEditError("INVALID_ANCHOR", `${label} anchor offset must be an integer.`, {
      label,
      nodeId: anchor.nodeId,
      offset: anchor.offset,
    });
  }

  switch (info.node.type) {
    case "text": {
      const textInfo = info as TextInfo;
      if (anchor.offset < 0 || anchor.offset > info.node.value.length) {
        throw new RangeEditError(
          "INVALID_ANCHOR",
          `${label} anchor offset is outside the text node.`,
          {
            label,
            nodeId: anchor.nodeId,
            offset: anchor.offset,
            textLength: info.node.value.length,
          },
        );
      }

      if (resolvesToSurrogateSplit(info.node.value, anchor.offset)) {
        throw new RangeEditError(
          "SPLIT_SURROGATE",
          `${label} anchor splits a valid surrogate pair.`,
          {
            label,
            nodeId: anchor.nodeId,
            offset: anchor.offset,
          },
        );
      }

      return {
        kind: "text",
        info: textInfo,
        offset: anchor.offset,
        position: info.start + anchor.offset,
      };
    }

    case "container": {
      const containerInfo = info as ContainerInfo;
      if (anchor.offset < 0 || anchor.offset > info.node.children.length) {
        throw new RangeEditError(
          "INVALID_ANCHOR",
          `${label} anchor offset is outside the container's child gaps.`,
          {
            label,
            nodeId: anchor.nodeId,
            offset: anchor.offset,
            childCount: info.node.children.length,
          },
        );
      }

      return {
        kind: "container",
        info: containerInfo,
        offset: anchor.offset,
        position: containerInfo.gaps[anchor.offset] as number,
      };
    }

    case "br":
    case "atom":
    case "atomic":
      throw new RangeEditError(
        "INVALID_ANCHOR",
        `${label} anchor must refer to a text or container node, not ${info.node.type}.`,
        {
          label,
          nodeId: anchor.nodeId,
          nodeType: info.node.type,
        },
      );
  }
}

function allocateId(
  generateId: () => string,
  existingIds: ReadonlySet<string>,
  generatedIds: Set<string>,
): string {
  let id: unknown;

  try {
    id = generateId();
  } catch (cause) {
    throw new RangeEditError("ID_GENERATION_FAILED", "The injected ID generator threw.", {
      cause,
    });
  }

  if (typeof id !== "string" || id.length === 0) {
    throw new RangeEditError("INVALID_ID", "Generated IDs must be non-empty strings.", {
      id,
    });
  }

  if (existingIds.has(id) || generatedIds.has(id)) {
    throw new RangeEditError("ID_COLLISION", "Generated ID collides with an existing node ID.", {
      id,
    });
  }

  generatedIds.add(id);
  return id;
}

function rangeContains(position: number, start: number, end: number): boolean {
  return position >= start && position < end;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function replaceRange(
  snapshot: Snapshot,
  request: ReplaceRequest,
  options: ReplaceOptions,
): ReplaceResult {
  const index = indexTree(snapshot);

  if (typeof options !== "object" || options === null) {
    throw new RangeEditError("INVALID_REQUEST", "Replace options must be an object.");
  }

  if (snapshot.version !== options.expectedVersion) {
    throw new RangeEditError("VERSION_MISMATCH", "The snapshot version does not match.", {
      expectedVersion: options.expectedVersion,
      actualVersion: snapshot.version,
    });
  }

  if (typeof options.generateId !== "function") {
    throw new RangeEditError("INVALID_REQUEST", "generateId must be a function.");
  }

  if (typeof request !== "object" || request === null) {
    throw new RangeEditError("INVALID_REQUEST", "Replace request must be an object.");
  }

  if (typeof request.text !== "string") {
    throw new RangeEditError("INVALID_REQUEST", "Replacement text must be a string.");
  }

  if (!isWellFormedUnicode(request.text)) {
    throw new RangeEditError(
      "INVALID_TEXT",
      "Replacement text contains an unpaired UTF-16 surrogate.",
    );
  }

  const startLocation = resolveAnchor(request.start, index, "start");
  const endLocation = resolveAnchor(request.end, index, "end");
  const startPosition = startLocation.position;
  const endPosition = endLocation.position;

  if (startPosition > endPosition) {
    throw new RangeEditError("UNORDERED_RANGE", "The normalized start is after the end.", {
      start: startPosition,
      end: endPosition,
    });
  }

  if (startPosition < endPosition) {
    for (const info of index.infos.values()) {
      if (
        (info.node.type === "atom" || info.node.type === "atomic") &&
        info.start >= startPosition &&
        info.start < endPosition
      ) {
        throw new RangeEditError(
          "ATOM_IN_RANGE",
          "The replacement range crosses an atomic character.",
          {
            atomId: info.node.id,
            atomPosition: info.start,
            start: startPosition,
            end: endPosition,
          },
        );
      }
    }
  }

  const existingIds = new Set(index.infos.keys());
  const generatedIds = new Set<string>();
  const replacementId = allocateId(options.generateId, existingIds, generatedIds);

  let suffixStart: number | null = null;
  let suffixId: string | null = null;

  if (startLocation.kind === "text" && endPosition <= startLocation.info.end) {
    const localEnd = endPosition - startLocation.info.start;
    const localSuffixStart = Math.max(startLocation.offset, localEnd);

    if (localSuffixStart < startLocation.info.node.value.length) {
      suffixStart = localSuffixStart;
      suffixId = allocateId(options.generateId, existingIds, generatedIds);
    }
  }

  const replacementNode: TextNode = {
    type: "text",
    id: replacementId,
    value: request.text,
  };

  const mapping: (number | null)[] = [];
  const retainedCharacters: CharacterOrigin[] = [];
  let replacementEmitted = false;

  const mapText = (value: string, oldStart: number | null): void => {
    for (let relative = 0; relative < value.length; relative += 1) {
      if (oldStart === null) {
        mapping.push(null);
      } else {
        const oldOffset = oldStart + relative;
        mapping.push(oldOffset);
        retainedCharacters.push({
          newOffset: mapping.length - 1,
          oldOffset,
        });
      }
    }
  };

  const emitReplacement = (): RichNode => {
    if (replacementEmitted) {
      throw new RangeEditError(
        "INVALID_REQUEST",
        "Internal insertion location was encountered more than once.",
      );
    }

    replacementEmitted = true;
    mapText(request.text, null);
    return replacementNode;
  };

  const rebuild = (node: RichNode): RichNode[] => {
    switch (node.type) {
      case "container": {
        const children: RichNode[] = [];
        const isInsertionContainer =
          startLocation.kind === "container" &&
          startLocation.info.node.id === node.id;

        for (let childIndex = 0; childIndex <= node.children.length; childIndex += 1) {
          if (isInsertionContainer && childIndex === startLocation.offset) {
            children.push(emitReplacement());
          }

          if (childIndex < node.children.length) {
            children.push(...rebuild(node.children[childIndex] as RichNode));
          }
        }

        const unchanged =
          children.length === node.children.length &&
          children.every((child, childIndex) => child === node.children[childIndex]);

        if (unchanged) {
          return [node];
        }

        return [
          {
            type: "container",
            id: node.id,
            children,
          },
        ];
      }

      case "text": {
        const info = index.infos.get(node.id) as TextInfo;
        const value = node.value;
        const isStartText =
          startLocation.kind === "text" && startLocation.info.node.id === node.id;

        if (isStartText && startLocation.kind === "text") {
          const leftValue = value.slice(0, startLocation.offset);
          const leftNode: TextNode =
            leftValue === value
              ? node
              : {
                  type: "text",
                  id: node.id,
                  value: leftValue,
                };

          mapText(leftValue, info.start);
          const emitted: RichNode[] = [
            leftNode,
            emitReplacement(),
          ];

          if (suffixStart !== null && suffixId !== null) {
            const suffixValue = value.slice(suffixStart);
            if (suffixValue.length > 0) {
              mapText(suffixValue, info.start + suffixStart);
              emitted.push({
                type: "text",
                id: suffixId,
                value: suffixValue,
              });
            }
          }

          return emitted;
        }

        if (value.length === 0) {
          return [];
        }

        if (info.end <= startPosition || info.start >= endPosition) {
          mapText(value, info.start);
          return [node];
        }

        const prefixLength = clamp(startPosition - info.start, 0, value.length);
        const suffixStartLocal = clamp(endPosition - info.start, 0, value.length);
        const emitted: RichNode[] = [];

        if (prefixLength > 0) {
          const prefixValue = value.slice(0, prefixLength);
          mapText(prefixValue, info.start);
          emitted.push({
            type: "text",
            id: node.id,
            value: prefixValue,
          });
        }

        if (suffixStartLocal < value.length) {
          const suffixValue = value.slice(suffixStartLocal);
          mapText(suffixValue, info.start + suffixStartLocal);
          emitted.push({
            type: "text",
            id: node.id,
            value: suffixValue,
          });
        }

        return emitted;
      }

      case "br": {
        const info = index.infos.get(node.id) as BreakInfo;
        if (rangeContains(info.start, startPosition, endPosition)) {
          return [];
        }

        mapping.push(info.start);
        retainedCharacters.push({
          newOffset: mapping.length - 1,
          oldOffset: info.start,
        });
        return [node];
      }

      case "atom":
      case "atomic": {
        const info = index.infos.get(node.id) as AtomicInfo;
        mapping.push(info.start);
        retainedCharacters.push({
          newOffset: mapping.length - 1,
          oldOffset: info.start,
        });
        return [node];
      }
    }
  };

  const rebuiltRoot = rebuild(snapshot.root);
  if (rebuiltRoot.length !== 1 || rebuiltRoot[0]?.type !== "container") {
    throw new RangeEditError(
      "INVALID_SNAPSHOT",
      "The edited tree did not produce a single root container.",
    );
  }

  if (!replacementEmitted) {
    throw new RangeEditError(
      "INVALID_ANCHOR",
      "The start anchor did not resolve to an insertion point.",
    );
  }

  const tree = rebuiltRoot[0];
  const editedSnapshot: Snapshot = {
    version: snapshot.version,
    root: tree,
  };

  return {
    snapshot: editedSnapshot,
    tree,
    cursor: {
      nodeId: replacementId,
      offset: request.text.length,
    },
    normalizedRange: {
      start: startPosition,
      end: endPosition,
    },
    mapping,
    retainedCharacters,
  };
}

export const applyRangeEdit = replaceRange;
export const replaceLogicalRange = replaceRange;

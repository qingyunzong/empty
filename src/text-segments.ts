/**
 * 网页抽取文本区段包。
 *
 * 输入为只读节点树（文本节点、元素标签、hidden 标记），输出按 Unicode
 * 码点组织的文本区段；每个输出码点附来源文本节点及 UTF-16 半开区间。
 */

/** 只读文本节点或元素节点。 */
export interface ReadNode {
  /** 文本节点为 true；元素节点为 false。 */
  readonly text: boolean;
  /** 文本节点的内容（按 UTF-16 编码，保证代理对有效）；元素节点为 null。 */
  readonly data: string | null;
  /** 元素标签名（大小写敏感，由调用方保证归一化）；文本节点为 null。 */
  readonly tag: string | null;
  /** 元素是否带 hidden 标记；文本节点恒为 false。 */
  readonly hidden?: boolean;
  /** 元素的只读子节点；文本节点为空数组。 */
  readonly children: readonly ReadNode[];
}

/** 单个输出码点在来源文本节点中的 UTF-16 半开区间 [start, end)。 */
export interface SourceRange {
  readonly node: ReadNode;
  readonly start: number;
  readonly end: number;
}

/** 一个输出码点对应的文本区段。 */
export interface TextSegment {
  /** 输出码点（合成换行固定为 "\n"）。 */
  readonly codepoint: string;
  /** 来源区间；合成换行为 null，其余情况至少包含一个区间。 */
  readonly sources: readonly SourceRange[] | null;
  /** 是否为合成换行。 */
  readonly isNewline: boolean;
}

/** 树遍历产生的原始原子。 */
type RawAtom =
  | { readonly kind: "char"; readonly codepoint: string; readonly source: SourceRange }
  | { readonly kind: "whitespace"; readonly codepoint: string; readonly source: SourceRange }
  | { readonly kind: "newline" };

/** 归一化管线中的原子；空格原子保留构成它的全部来源区间。 */
type NormAtom =
  | {
      readonly kind: "char";
      readonly codepoint: string;
      readonly sources: readonly SourceRange[];
    }
  | { readonly kind: "space"; readonly sources: readonly SourceRange[] }
  | { readonly kind: "newline" };

/** ASCII 空白：空格、制表、CR、LF、换页。 */
function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a || code === 0x0c;
}

const SKIPPED_TAGS: ReadonlySet<string> = new Set(["script", "style"]);

/**
 * 深度优先遍历只读树，输出字符、空白与换行原子。
 *
 * - 跳过 hidden 子树及 script/style 子树；
 * - br 请求一次换行；
 * - 块元素进入与退出各请求一次换行。
 */
function collectAtoms(root: ReadNode, blockTags: ReadonlySet<string>): RawAtom[] {
  const atoms: RawAtom[] = [];

  const walk = (node: ReadNode): void => {
    if (node.text) {
      const data = node.data ?? "";
      let index = 0;
      while (index < data.length) {
        const code = data.codePointAt(index) as number;
        const char = String.fromCodePoint(code);
        const next = index + char.length;
        const source: SourceRange = { node, start: index, end: next };
        atoms.push(
          isAsciiWhitespace(code)
            ? { kind: "whitespace", codepoint: char, source }
            : { kind: "char", codepoint: char, source },
        );
        index = next;
      }
      return;
    }

    if (node.hidden === true) {
      return;
    }
    const tag = node.tag ?? "";
    if (SKIPPED_TAGS.has(tag)) {
      return;
    }
    if (tag === "br") {
      atoms.push({ kind: "newline" });
      return;
    }

    const isBlock = blockTags.has(tag);
    if (isBlock) {
      atoms.push({ kind: "newline" });
    }
    for (const child of node.children) {
      walk(child);
    }
    if (isBlock) {
      atoms.push({ kind: "newline" });
    }
  };

  walk(root);
  return atoms;
}

/**
 * 从只读树抽取文本区段。
 *
 * @param root 只读节点树的根节点
 * @param blockTags 调用方显式给定的块级元素标签集合（大小写敏感）
 */
export function extractTextSegments(
  root: ReadNode,
  blockTags: ReadonlySet<string>,
): TextSegment[] {
  const rawAtoms = collectAtoms(root, blockTags);

  // 第一阶段：连续 ASCII 空白（含跨节点）压成一个空格，保留全部来源区间。
  const collapsed: NormAtom[] = [];
  let pendingSpaces: SourceRange[] = [];
  const flushSpaces = (): void => {
    if (pendingSpaces.length > 0) {
      collapsed.push({
        kind: "space",
        sources: pendingSpaces,
      });
      pendingSpaces = [];
    }
  };

  for (const atom of rawAtoms) {
    if (atom.kind === "whitespace") {
      pendingSpaces.push(atom.source);
    } else {
      flushSpaces();
      if (atom.kind === "newline") {
        collapsed.push({ kind: "newline" });
      } else {
        collapsed.push({
          kind: "char",
          codepoint: atom.codepoint,
          sources: [atom.source],
        });
      }
    }
  }
  flushSpaces();

  // 第二阶段：删除紧邻换行的空格（需前瞻判断空格两侧是否存在换行）。
  const withoutAdjacentSpaces: NormAtom[] = collapsed.filter((atom, index) => {
    if (atom.kind !== "space") {
      return true;
    }
    const previous = collapsed[index - 1];
    const next = collapsed[index + 1];
    const touchesNewline =
      (previous !== undefined && previous.kind === "newline") ||
      (next !== undefined && next.kind === "newline");
    return !touchesNewline;
  });

  // 第三阶段：相邻换行请求合并为一次；首尾换行删除。
  const mergedNewlines: NormAtom[] = [];
  for (const atom of withoutAdjacentSpaces) {
    if (
      atom.kind === "newline" &&
      mergedNewlines.length > 0 &&
      (mergedNewlines[mergedNewlines.length - 1] as NormAtom).kind === "newline"
    ) {
      continue;
    }
    mergedNewlines.push(atom);
  }
  const normalized = mergedNewlines;
  while (
    normalized.length > 0 &&
    (normalized[0] as NormAtom).kind === "newline"
  ) {
    normalized.shift();
  }
  while (
    normalized.length > 0 &&
    (normalized[normalized.length - 1] as NormAtom).kind === "newline"
  ) {
    normalized.pop();
  }

  return normalized.map((atom): TextSegment => {
    if (atom.kind === "newline") {
      return { codepoint: "\n", sources: null, isNewline: true };
    }
    return {
      codepoint: atom.kind === "space" ? " " : atom.codepoint,
      sources: atom.sources,
      isNewline: false,
    };
  });
}

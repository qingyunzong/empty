/**
 * indent-tree: an editor-oriented incremental indentation syntax tree.
 *
 * Grammar
 * -------
 * - The tree is formed by SPACE indentation only.
 * - A TAB in the leading whitespace of a line is rejected: the line is
 *   reported as an error line (it still participates in the tree using its
 *   space-only indentation so the tree stays total).
 * - Blank lines (empty or whitespace-only) never change the indentation
 *   stack and produce no nodes.
 * - A dedent that lands between two ancestor indentation levels is reported
 *   as an error line; the line is attached as a child of the nearest
 *   shallower ancestor so parsing can continue.
 *
 * Incrementality
 * --------------
 * Tokenization is line-local, so an edit only re-tokenizes the touched
 * lines. Reparsing starts at the last unchanged line before the edit,
 * reconstructing the exact parser stack from the previous parse, and
 * stops as soon as the live stack (checked before the line's pops, so
 * dedent errors introduced by the edit are never skipped) equals the
 * pre-edit stack at an unchanged line. Node ids are preserved for
 * every line that maps to a pre-edit line (unchanged context, shifted
 * lines, and positionally matched replaced lines); only genuinely new
 * lines receive fresh ids. The resulting tree is semantically identical
 * to a full reparse of the new text.
 */

export interface LineError {
  /** 0-based line number. */
  line: number;
  message: string;
}

export interface NodeInfo {
  id: number;
  line: number;
  indent: number;
  content: string;
  depth: number;
  parentId: number;
}

export interface TreeNode {
  id: number;
  content: string;
  indent: number;
  line: number;
  children: TreeNode[];
}

export interface ChangeSet {
  added: NodeInfo[];
  removed: NodeInfo[];
  updated: NodeInfo[];
}

export interface EditResult {
  changes: ChangeSet;
  errors: LineError[];
  /** Half-open line range [start, end) that was actually reparsed. */
  reparseRange: { start: number; end: number };
}

/** Id of the virtual root node. */
export const ROOT_ID = 0;

interface Token {
  blank: boolean;
  indent: number;
  content: string;
  tabError: boolean;
}

interface NodeRec {
  id: number;
  indent: number;
  content: string;
  depth: number;
}

interface StackEntry {
  indent: number;
  depth: number;
}

function tokenize(line: string): Token {
  const lead = /^[ \t]*/.exec(line)![0];
  const tabError = lead.includes('\t');
  // Tabs are rejected (reported) and do not count towards indentation.
  const indent = lead.replace(/\t/g, '').length;
  const content = line.slice(lead.length);
  const blank = content.trim().length === 0;
  return { blank, indent, content, tabError };
}

export class IndentDocument {
  private lines: string[] = [];
  private tokens: Token[] = [];
  /** Indexed by line number; null for blank lines. Records are never
   *  mutated in place, so shallow snapshots stay valid. */
  private nodes: (NodeRec | null)[] = [];
  /** Dedent-mismatch errors produced by the parser, keyed by line. */
  private parseErrors = new Map<number, string>();
  private nextId = 1;

  constructor(text = '') {
    // The initial load goes through the exact same incremental path as
    // any later edit (an insertion into an empty document).
    this.applyEdit(0, 0, text.split('\n'));
  }

  /** Full reparse of a text, used as the reference oracle in tests. */
  static fullParse(text: string): { tree: TreeNode; errors: LineError[] } {
    const doc = new IndentDocument(text);
    return { tree: doc.toJSON(), errors: doc.errors() };
  }

  get lineCount(): number {
    return this.lines.length;
  }

  getText(): string {
    return this.lines.join('\n');
  }

  /** Id of the node owning `line`, or null for blank lines. */
  nodeIdAtLine(line: number): number | null {
    const rec = this.nodes[line];
    return rec ? rec.id : null;
  }

  /**
   * Replace `deleteCount` lines starting at `start` with `inserted`.
   * Only the affected region is reparsed; returns the changed nodes and
   * the current error lines.
   */
  applyEdit(start: number, deleteCount: number, inserted: string[]): EditResult {
    const oldLength = this.lines.length;
    start = Math.max(0, Math.min(start, oldLength));
    deleteCount = Math.max(0, Math.min(deleteCount, oldLength - start));
    const delta = inserted.length - deleteCount;
    const editEnd = start + inserted.length; // in post-edit coordinates

    const before = this.snapshot();
    // Shallow copy: records are immutable, so this preserves the old parse.
    const oldNodes = this.nodes.slice();

    // 1. Splice raw lines, re-tokenize only the inserted lines.
    this.lines.splice(start, deleteCount, ...inserted);
    this.tokens.splice(start, deleteCount, ...inserted.map(tokenize));
    this.nodes.splice(start, deleteCount, ...new Array(inserted.length).fill(null));

    // 2. Shift parse errors outside the edited range; drop deleted ones.
    const shiftedErrors = new Map<number, string>();
    for (const [line, message] of this.parseErrors) {
      if (line < start) shiftedErrors.set(line, message);
      else if (line >= start + deleteCount) shiftedErrors.set(line + delta, message);
    }
    this.parseErrors = shiftedErrors;

    // 3. Replaced lines keep their id when they positionally match a
    //    deleted line (a "modify this line" edit keeps the node's identity).
    const idReuse = new Map<number, number>();
    const overlap = Math.min(deleteCount, inserted.length);
    for (let i = 0; i < overlap; i++) {
      const oldRec = oldNodes[start + i];
      if (oldRec) idReuse.set(start + i, oldRec.id);
    }

    // 4. Reparse starts at the last unchanged non-blank line before the
    //    edit. The parser stack there is reconstructed from the previous
    //    parse: the ancestor chain of the previous non-blank line plus
    //    that line itself. (Starting at a top-level line with an empty
    //    stack would be wrong when the document begins indented.)
    const stack: StackEntry[] = [];
    let reparseStart = 0;
    {
      let s = Math.min(start, this.tokens.length) - 1;
      while (s >= 0 && this.tokens[s].blank) s--;
      if (s >= 0) {
        reparseStart = s;
        let prev = s - 1;
        while (prev >= 0 && !oldNodes[prev]) prev--;
        if (prev >= 0) {
          const prevRec = oldNodes[prev]!;
          const chain: (StackEntry | null)[] = new Array(prevRec.depth + 1).fill(null);
          chain[prevRec.depth] = { indent: prevRec.indent, depth: prevRec.depth };
          let need = prevRec.depth - 1;
          for (let j = prev - 1; j >= 0 && need >= 0; j--) {
            const ancestor = oldNodes[j];
            if (ancestor && ancestor.depth === need) {
              chain[need] = { indent: ancestor.indent, depth: need };
              need--;
            }
          }
          for (const entry of chain) stack.push(entry!);
        }
      }
    }

    // 5. Reparse forward until the stack re-synchronizes with the old
    //    parse at an unchanged line, or the document ends.
    const newErrors: LineError[] = [];
    let reparseEnd = this.tokens.length;
    for (let i = reparseStart; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      if (tok.blank) {
        this.nodes[i] = null;
        continue;
      }
      // Re-synchronization is checked against the live stack BEFORE this
      // line's pops: it must equal the pre-edit stack at the same logical
      // line, which makes the rest of the parse (tree and errors) identical.
      if (i >= editEnd) {
        const oldRec = oldNodes[i - delta];
        if (oldRec && IndentDocument.prePopStackMatches(stack, oldNodes, i - delta)) {
          reparseEnd = i;
          break;
        }
      }
      // A dedent is invalid only when it passes a deeper level without
      // landing exactly on any popped (or remaining) outer level.
      let poppedDeeper = false;
      let poppedEqual = false;
      while (stack.length > 0 && stack[stack.length - 1].indent >= tok.indent) {
        if (stack[stack.length - 1].indent > tok.indent) poppedDeeper = true;
        else poppedEqual = true;
        stack.pop();
      }
      if (poppedDeeper && !poppedEqual) {
        newErrors.push({
          line: i,
          message: `unindent to ${tok.indent} does not match any outer indentation level`,
        });
      }
      const depth = stack.length > 0 ? stack[stack.length - 1].depth + 1 : 0;
      stack.push({ indent: tok.indent, depth });

      let id: number;
      const reused = idReuse.get(i);
      // Unchanged context lines (before the edit) and shifted lines
      // (after the edit) keep their old node id.
      const carried =
        i < start ? oldNodes[i] : i >= editEnd ? oldNodes[i - delta] : null;
      if (reused !== undefined) id = reused;
      else if (carried) id = carried.id;
      else id = this.nextId++;
      this.nodes[i] = { id, indent: tok.indent, content: tok.content, depth };
    }

    // 6. Replace parse errors inside the reparsed range.
    for (const line of [...this.parseErrors.keys()]) {
      if (line >= reparseStart && line < reparseEnd) this.parseErrors.delete(line);
    }
    for (const err of newErrors) this.parseErrors.set(err.line, err.message);

    // 7. Diff node identities and semantics against the pre-edit snapshot.
    const after = this.snapshot();
    const added: NodeInfo[] = [];
    const removed: NodeInfo[] = [];
    const updated: NodeInfo[] = [];
    for (const [id, info] of after) {
      const prev = before.get(id);
      if (!prev) {
        added.push(info);
      } else if (
        prev.content !== info.content ||
        prev.indent !== info.indent ||
        prev.depth !== info.depth ||
        prev.parentId !== info.parentId
      ) {
        updated.push(info);
      }
    }
    for (const [id, info] of before) {
      if (!after.has(id)) removed.push(info);
    }

    return {
      changes: { added, removed, updated },
      errors: this.errors(),
      reparseRange: { start: reparseStart, end: reparseEnd },
    };
  }

  /** Current error lines: rejected tabs plus dedent mismatches, sorted. */
  errors(): LineError[] {
    const result: LineError[] = [];
    for (let i = 0; i < this.tokens.length; i++) {
      if (this.tokens[i].tabError) {
        result.push({ line: i, message: 'tab character is not allowed in indentation' });
      }
    }
    for (const [line, message] of this.parseErrors) result.push({ line, message });
    return result.sort((a, b) => a.line - b.line);
  }

  /** Materialize the nested tree (root is the virtual node ROOT_ID). */
  toJSON(): TreeNode {
    const root: TreeNode = { id: ROOT_ID, content: '', indent: -1, line: -1, children: [] };
    // stack[k] holds the node at depth k-1, so a node of depth d finds
    // its parent at stack[d].
    const stack: TreeNode[] = [root];
    for (let line = 0; line < this.nodes.length; line++) {
      const rec = this.nodes[line];
      if (!rec) continue;
      const node: TreeNode = {
        id: rec.id,
        content: rec.content,
        indent: rec.indent,
        line,
        children: [],
      };
      stack[rec.depth].children.push(node);
      stack[rec.depth + 1] = node;
      stack.length = rec.depth + 2;
    }
    return root;
  }

  /** Flat view of all nodes with derived parent ids. */
  nodeList(): NodeInfo[] {
    return [...this.snapshot().values()];
  }

  private snapshot(): Map<number, NodeInfo> {
    const map = new Map<number, NodeInfo>();
    const stack: NodeRec[] = [];
    for (let line = 0; line < this.nodes.length; line++) {
      const rec = this.nodes[line];
      if (!rec) continue;
      while (stack.length > 0 && stack[stack.length - 1].depth >= rec.depth) stack.pop();
      const parentId = stack.length > 0 ? stack[stack.length - 1].id : ROOT_ID;
      map.set(rec.id, {
        id: rec.id,
        line,
        indent: rec.indent,
        content: rec.content,
        depth: rec.depth,
        parentId,
      });
      stack.push(rec);
    }
    return map;
  }

  /**
   * True when the live parser stack (before any pops for the current line)
   * equals the stack the pre-edit parse held just before old line
   * `oldLine`. That stack is the ancestor chain of the previous non-blank
   * old line plus that line itself; depths are always 0..n-1, so comparing
   * lengths and indents suffices.
   */
  private static prePopStackMatches(
    stack: StackEntry[],
    oldNodes: (NodeRec | null)[],
    oldLine: number,
  ): boolean {
    const rec = oldNodes[oldLine];
    if (!rec) return false;
    let prevLine = oldLine - 1;
    while (prevLine >= 0 && !oldNodes[prevLine]) prevLine--;
    if (prevLine < 0) return stack.length === 0;
    const prev = oldNodes[prevLine]!;
    if (prev.depth + 1 !== stack.length) return false;
    let needDepth = prev.depth;
    let idx = stack.length - 1;
    for (let j = prevLine; j >= 0 && needDepth >= 0; j--) {
      const ancestor = oldNodes[j];
      if (ancestor && ancestor.depth === needDepth) {
        if (ancestor.indent !== stack[idx].indent) return false;
        needDepth--;
        idx--;
      }
    }
    return needDepth < 0;
  }
}

import { bind, type Decl, type Scope } from "./binder.js";
import { isIdentifierName } from "./lexer.js";
import { parse } from "./parser.js";

/** A single byte edit: replace source[start..end) with newText. */
export interface Edit {
  start: number;
  end: number;
  newText: string;
}

export type RenameErrorCode =
  | "parse-error"
  | "no-identifier-at-position"
  | "unresolved-identifier"
  | "invalid-new-name"
  | "conflict"
  | "capture";

export interface RenameFailure {
  ok: false;
  code: RenameErrorCode;
  message: string;
}

export interface RenameSuccess {
  ok: true;
  oldName: string;
  newName: string;
  /** Byte span of the renamed declaration's name. */
  declarationSpan: { start: number; end: number };
  /** Number of occurrences covered by the plan (declaration + references). */
  occurrences: number;
  /**
   * Byte-edit plan: sorted by `start`, strictly non-overlapping. Applying all
   * edits renames the declaration and exactly the references that resolve to
   * it — nothing else.
   */
  edits: Edit[];
}

export type RenameResult = RenameSuccess | RenameFailure;

function fail(code: RenameErrorCode, message: string): RenameFailure {
  return { ok: false, code, message };
}

function containsOffset(span: { start: number; end: number }, position: number): boolean {
  return span.start <= position && position <= span.end;
}

/**
 * Plans a rename of the declaration found at `position` (a byte offset on
 * either the declaration's name or on any reference that resolves to it).
 *
 * Safety rules:
 *  - Only references that resolve to the target declaration are renamed;
 *    shadowed names in nested blocks are left untouched.
 *  - If the new name would cause capture, the ENTIRE rename is rejected and
 *    no edits are produced. Capture happens when:
 *      (a) a reference of the target would, after renaming, be stolen by an
 *          intervening declaration of `newName` between the reference and the
 *          target's block; or
 *      (b) an existing reference to `newName` (resolved to another
 *          declaration, or currently unresolved) lies in a scope where it
 *          would suddenly resolve to the renamed declaration.
 *  - If the target's own block already declares `newName`, the rename is a
 *    conflict and is rejected.
 */
export function planRename(source: string, position: number, newName: string): RenameResult {
  let program;
  try {
    program = parse(source);
  } catch (error) {
    return fail("parse-error", error instanceof Error ? error.message : String(error));
  }
  const { declarations, references } = bind(program);

  if (!isIdentifierName(newName)) {
    return fail(
      "invalid-new-name",
      `'${newName}' is not a valid identifier (or is a reserved keyword)`,
    );
  }

  // Locate the target declaration: cursor on a declaration name, or on a
  // reference (resolved through the scope chain).
  let target: Decl | undefined = declarations.find((d) =>
    containsOffset(d.nameSpan, position),
  );
  if (!target) {
    const ref = references.find((r) => containsOffset(r.span, position));
    if (ref) {
      if (!ref.decl) {
        return fail(
          "unresolved-identifier",
          `identifier '${ref.name}' at offset ${ref.span.start} does not resolve to any declaration`,
        );
      }
      target = ref.decl;
    }
  }
  if (!target) {
    return fail("no-identifier-at-position", `no identifier at offset ${position}`);
  }

  const targetScope: Scope = target.scope;

  // Conflict: the same block already declares the new name.
  const clash = targetScope.declarations.get(newName);
  if (clash && clash !== target) {
    return fail(
      "conflict",
      `block already declares '${newName}' at offset ${clash.nameSpan.start}`,
    );
  }

  // Capture (a): a reference of the target would be stolen by an intervening
  // declaration of newName between the reference's scope and the target's
  // scope.
  for (const ref of target.refs) {
    let scope: Scope | null = ref.scope;
    while (scope && scope !== targetScope) {
      const thief = scope.declarations.get(newName);
      if (thief) {
        return fail(
          "capture",
          `renaming to '${newName}' would capture the reference at offset ${ref.span.start}: ` +
            `it would resolve to the declaration of '${newName}' at offset ${thief.nameSpan.start}`,
        );
      }
      scope = scope.parent;
    }
  }

  // Capture (b): an existing reference spelled `newName` (bound to another
  // declaration, or unbound) would suddenly resolve to the renamed
  // declaration because the target's scope sits on its resolution path.
  for (const ref of references) {
    if (ref.name !== newName) continue;
    const resolvingScope = ref.decl ? ref.decl.scope : null;
    let scope: Scope | null = ref.scope;
    while (scope && scope !== resolvingScope) {
      if (scope === targetScope) {
        const boundTo = ref.decl
          ? `the declaration at offset ${ref.decl.nameSpan.start}`
          : "no declaration (it is currently unresolved)";
        return fail(
          "capture",
          `renaming to '${newName}' would capture the reference at offset ${ref.span.start}: ` +
            `it currently resolves to ${boundTo}`,
        );
      }
      scope = scope.parent;
    }
  }

  const spans = [target.nameSpan, ...target.refs.map((r) => r.span)].sort(
    (a, b) => a.start - b.start,
  );
  const edits: Edit[] = spans.map((span) => ({
    start: span.start,
    end: span.end,
    newText: newName,
  }));
  return {
    ok: true,
    oldName: target.name,
    newName,
    declarationSpan: { ...target.nameSpan },
    occurrences: edits.length,
    edits,
  };
}

/**
 * Applies a byte-edit plan. Edits may be given in any order; they must not
 * overlap. Edits are applied from the end of the source backwards so earlier
 * offsets stay valid.
 */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.start < prev.end) {
      throw new Error(
        `overlapping edits: [${prev.start}, ${prev.end}) and [${curr.start}, ${curr.end})`,
      );
    }
  }
  let out = source;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const edit = sorted[i]!;
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  }
  return out;
}

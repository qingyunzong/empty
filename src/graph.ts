export type SymbolId = string;

export interface AddSymbolOptions {
  public?: boolean;
}

interface SymbolNode {
  isPublic: boolean;
  references: Set<SymbolId>;
}

/**
 * Directed symbol reference graph. An edge A -> B means "A references B",
 * so a change to B can impact A and everything that (transitively) references B.
 */
export class SymbolGraph {
  private readonly nodes = new Map<SymbolId, SymbolNode>();

  addSymbol(id: SymbolId, options: AddSymbolOptions = {}): this {
    const existing = this.nodes.get(id);
    if (existing) {
      if (options.public === true) existing.isPublic = true;
      return this;
    }
    this.nodes.set(id, { isPublic: options.public === true, references: new Set() });
    return this;
  }

  addReference(from: SymbolId, to: SymbolId): this {
    if (!this.nodes.has(from)) this.addSymbol(from);
    if (!this.nodes.has(to)) this.addSymbol(to);
    this.nodes.get(from)!.references.add(to);
    return this;
  }

  has(id: SymbolId): boolean {
    return this.nodes.has(id);
  }

  isPublic(id: SymbolId): boolean {
    return this.nodes.get(id)?.isPublic ?? false;
  }

  referencesOf(id: SymbolId): readonly SymbolId[] {
    const node = this.nodes.get(id);
    return node ? [...node.references] : [];
  }

  symbolIds(): SymbolId[] {
    return [...this.nodes.keys()];
  }

  publicEntries(): SymbolId[] {
    const entries: SymbolId[] = [];
    for (const [id, node] of this.nodes) {
      if (node.isPublic) entries.push(id);
    }
    return entries.sort();
  }

  /** Reverse adjacency: symbol -> symbols that directly reference it. */
  referencedBy(): Map<SymbolId, SymbolId[]> {
    const reverse = new Map<SymbolId, SymbolId[]>();
    for (const id of this.nodes.keys()) reverse.set(id, []);
    for (const [from, node] of this.nodes) {
      for (const to of node.references) {
        reverse.get(to)!.push(from);
      }
    }
    for (const list of reverse.values()) list.sort();
    return reverse;
  }

  get size(): number {
    return this.nodes.size;
  }
}

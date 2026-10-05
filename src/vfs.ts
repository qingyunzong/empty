import { AlreadyExistsError, IsDirectoryError, NotDirectoryError, NotFoundError } from './errors.js';

export type NodeKind = 'dir' | 'file' | 'symlink';

let nextNodeId = 1;

export class DirNode {
  readonly kind = 'dir' as const;
  readonly id = nextNodeId++;
  /** Bumped on every structural mutation of this directory's entries. */
  generation = 0;
  readonly children = new Map<string, VfsNode>();
  constructor(
    readonly name: string,
    readonly parent: DirNode | null,
  ) {}
}

export class FileNode {
  readonly kind = 'file' as const;
  readonly id = nextNodeId++;
  /** How many times this file object was actually opened. */
  openCount = 0;
  constructor(
    readonly name: string,
    public content: string,
  ) {}
}

export class SymlinkNode {
  readonly kind = 'symlink' as const;
  readonly id = nextNodeId++;
  constructor(
    readonly name: string,
    public target: string,
  ) {}
}

export type VfsNode = DirNode | FileNode | SymlinkNode;

function splitPath(path: string): string[] {
  return path.split('/').filter((c) => c.length > 0 && c !== '.');
}

/**
 * In-memory virtual file tree. This is the "host system" interface: mutations
 * here are unrestricted (no sandbox checks) and model what an attacker or
 * another process could do between a victim's check and open.
 */
export class VirtualFileTree {
  readonly root = new DirNode('', null);

  private walk(path: string): VfsNode {
    const comps = splitPath(path);
    let node: VfsNode = this.root;
    for (const comp of comps) {
      if (node.kind !== 'dir') throw new NotDirectoryError(path);
      const child = node.children.get(comp);
      if (!child) throw new NotFoundError(path);
      node = child;
    }
    return node;
  }

  private walkParent(path: string): { parent: DirNode; name: string } {
    const comps = splitPath(path);
    const name = comps.pop();
    if (name === undefined) throw new IsDirectoryError(path);
    const parent = this.walk('/' + comps.join('/'));
    if (parent.kind !== 'dir') throw new NotDirectoryError(path);
    return { parent, name };
  }

  mkdir(path: string): DirNode {
    const { parent, name } = this.walkParent(path);
    if (parent.children.has(name)) throw new AlreadyExistsError(path);
    const dir = new DirNode(name, parent);
    parent.children.set(name, dir);
    parent.generation++;
    return dir;
  }

  writeFile(path: string, content: string): FileNode {
    const { parent, name } = this.walkParent(path);
    const existing = parent.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw new IsDirectoryError(path);
      existing.content = content;
      return existing;
    }
    const file = new FileNode(name, content);
    parent.children.set(name, file);
    parent.generation++;
    return file;
  }

  symlink(target: string, path: string): SymlinkNode {
    const { parent, name } = this.walkParent(path);
    if (parent.children.has(name)) throw new AlreadyExistsError(path);
    const link = new SymlinkNode(name, target);
    parent.children.set(name, link);
    parent.generation++;
    return link;
  }

  /** Atomically retarget an existing symlink (models a hostile link swap). */
  retargetSymlink(path: string, newTarget: string): void {
    const { parent, name } = this.walkParent(path);
    const node = parent.children.get(name);
    if (!node) throw new NotFoundError(path);
    if (node.kind !== 'symlink') throw new NotDirectoryError(path);
    node.target = newTarget;
    parent.generation++;
  }

  unlink(path: string): void {
    const { parent, name } = this.walkParent(path);
    if (!parent.children.delete(name)) throw new NotFoundError(path);
    parent.generation++;
  }

  getNode(path: string): VfsNode {
    return this.walk(path);
  }
}

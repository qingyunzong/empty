import { FsError } from "./errors.js";
import { normalizeSegments, splitPath } from "./pathutil.js";

export interface DirNode {
  kind: "dir";
  children: Map<string, VNode>;
  /** Bumped on every structural change to `children` (add/replace/remove). */
  generation: number;
}

export interface FileNode {
  kind: "file";
  content: string;
  /** Number of times the file was successfully opened through a Sandbox. */
  openCount: number;
}

export interface SymlinkNode {
  kind: "symlink";
  /** Absolute (vfs-absolute, leading "/") or directory-relative target. */
  target: string;
}

export type VNode = DirNode | FileNode | SymlinkNode;

export function dir(): DirNode {
  return { kind: "dir", children: new Map(), generation: 0 };
}

export function file(content: string): FileNode {
  return { kind: "file", content, openCount: 0 };
}

export function symlink(target: string): SymlinkNode {
  return { kind: "symlink", target };
}

/**
 * In-memory virtual file tree. All setup paths are vfs-absolute and are
 * interpreted literally (no symlink following): this is the "host" side
 * used to plant files, directories and links, and to simulate an attacker
 * swapping a symlink between a victim's check and open.
 */
export class Vfs {
  readonly root: DirNode = dir();

  mkdirp(path: string): DirNode {
    let node = this.root;
    for (const comp of normalizeSegments([], splitPath(path))) {
      let child = node.children.get(comp);
      if (child === undefined) {
        child = dir();
        this.setChild(node, comp, child);
      }
      if (child.kind !== "dir") {
        throw new FsError("ENOTDIR", `mkdirp: not a directory: ${path}`);
      }
      node = child;
    }
    return node;
  }

  writeFile(path: string, content: string): FileNode {
    const { parent, name } = this.parentOf(path);
    const node = file(content);
    this.setChild(parent, name, node);
    return node;
  }

  addSymlink(path: string, target: string): SymlinkNode {
    const { parent, name } = this.parentOf(path);
    const node = symlink(target);
    this.setChild(parent, name, node);
    return node;
  }

  /** Replace an existing child (the "swap the link" operation). */
  replace(path: string, node: VNode): void {
    const { parent, name } = this.parentOf(path);
    if (!parent.children.has(name)) {
      throw new FsError("ENOENT", `replace: no such entry: ${path}`);
    }
    this.setChild(parent, name, node);
  }

  remove(path: string): void {
    const { parent, name } = this.parentOf(path);
    if (!parent.children.delete(name)) {
      throw new FsError("ENOENT", `remove: no such entry: ${path}`);
    }
    parent.generation++;
  }

  /** Literal lookup without following symlinks. */
  getRaw(path: string): VNode | undefined {
    let node: VNode = this.root;
    for (const comp of normalizeSegments([], splitPath(path))) {
      if (node.kind !== "dir") return undefined;
      const next: VNode | undefined = node.children.get(comp);
      if (next === undefined) return undefined;
      node = next;
    }
    return node;
  }

  private setChild(parent: DirNode, name: string, node: VNode): void {
    parent.children.set(name, node);
    parent.generation++;
  }

  private parentOf(path: string): { parent: DirNode; name: string } {
    const comps = normalizeSegments([], splitPath(path));
    const name = comps.pop();
    if (name === undefined) {
      throw new FsError("EINVAL", `bad path: ${path}`);
    }
    let node = this.root;
    for (const comp of comps) {
      const child = node.children.get(comp);
      if (child === undefined || child.kind !== "dir") {
        throw new FsError("ENOENT", `no such directory in path: ${path}`);
      }
      node = child;
    }
    return { parent: node, name };
  }
}

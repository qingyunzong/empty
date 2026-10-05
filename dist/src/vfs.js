import { AlreadyExistsError, IsDirectoryError, NotDirectoryError, NotFoundError } from './errors.js';
let nextNodeId = 1;
export class DirNode {
    name;
    parent;
    kind = 'dir';
    id = nextNodeId++;
    /** Bumped on every structural mutation of this directory's entries. */
    generation = 0;
    children = new Map();
    constructor(name, parent) {
        this.name = name;
        this.parent = parent;
    }
}
export class FileNode {
    name;
    content;
    kind = 'file';
    id = nextNodeId++;
    /** How many times this file object was actually opened. */
    openCount = 0;
    constructor(name, content) {
        this.name = name;
        this.content = content;
    }
}
export class SymlinkNode {
    name;
    target;
    kind = 'symlink';
    id = nextNodeId++;
    constructor(name, target) {
        this.name = name;
        this.target = target;
    }
}
function splitPath(path) {
    return path.split('/').filter((c) => c.length > 0 && c !== '.');
}
/**
 * In-memory virtual file tree. This is the "host system" interface: mutations
 * here are unrestricted (no sandbox checks) and model what an attacker or
 * another process could do between a victim's check and open.
 */
export class VirtualFileTree {
    root = new DirNode('', null);
    walk(path) {
        const comps = splitPath(path);
        let node = this.root;
        for (const comp of comps) {
            if (node.kind !== 'dir')
                throw new NotDirectoryError(path);
            const child = node.children.get(comp);
            if (!child)
                throw new NotFoundError(path);
            node = child;
        }
        return node;
    }
    walkParent(path) {
        const comps = splitPath(path);
        const name = comps.pop();
        if (name === undefined)
            throw new IsDirectoryError(path);
        const parent = this.walk('/' + comps.join('/'));
        if (parent.kind !== 'dir')
            throw new NotDirectoryError(path);
        return { parent, name };
    }
    mkdir(path) {
        const { parent, name } = this.walkParent(path);
        if (parent.children.has(name))
            throw new AlreadyExistsError(path);
        const dir = new DirNode(name, parent);
        parent.children.set(name, dir);
        parent.generation++;
        return dir;
    }
    writeFile(path, content) {
        const { parent, name } = this.walkParent(path);
        const existing = parent.children.get(name);
        if (existing) {
            if (existing.kind !== 'file')
                throw new IsDirectoryError(path);
            existing.content = content;
            return existing;
        }
        const file = new FileNode(name, content);
        parent.children.set(name, file);
        parent.generation++;
        return file;
    }
    symlink(target, path) {
        const { parent, name } = this.walkParent(path);
        if (parent.children.has(name))
            throw new AlreadyExistsError(path);
        const link = new SymlinkNode(name, target);
        parent.children.set(name, link);
        parent.generation++;
        return link;
    }
    /** Atomically retarget an existing symlink (models a hostile link swap). */
    retargetSymlink(path, newTarget) {
        const { parent, name } = this.walkParent(path);
        const node = parent.children.get(name);
        if (!node)
            throw new NotFoundError(path);
        if (node.kind !== 'symlink')
            throw new NotDirectoryError(path);
        node.target = newTarget;
        parent.generation++;
    }
    unlink(path) {
        const { parent, name } = this.walkParent(path);
        if (!parent.children.delete(name))
            throw new NotFoundError(path);
        parent.generation++;
    }
    getNode(path) {
        return this.walk(path);
    }
}

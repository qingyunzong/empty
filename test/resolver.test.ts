import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FileNode,
  NotDirectoryError,
  NotFoundError,
  SandboxEscapeError,
  SandboxResolver,
  SymlinkLoopError,
  TooManyExpansionsError,
  VirtualFileTree,
} from '../src/index.js';

function makeTree() {
  const tree = new VirtualFileTree();
  tree.mkdir('/sandbox');
  tree.mkdir('/sandbox/sub');
  tree.mkdir('/sandbox/sub/deep');
  tree.writeFile('/sandbox/inner.txt', 'inside');
  tree.writeFile('/sandbox/sub/deep/nested.txt', 'nested');
  tree.mkdir('/external');
  tree.writeFile('/external/secret.txt', 'TOP-SECRET');
  const sandboxRoot = tree.getNode('/sandbox');
  if (sandboxRoot.kind !== 'dir') throw new Error('bad fixture');
  return { tree, sandboxRoot };
}

describe('SandboxResolver: relative paths', () => {
  it('resolves plain and dotted relative paths', () => {
    const { tree, sandboxRoot } = makeTree();
    const resolver = new SandboxResolver(tree, sandboxRoot);
    const plain = resolver.resolve('inner.txt');
    assert.equal(plain.node.kind, 'file');
    const dotted = resolver.resolve('./sub/./deep/nested.txt');
    assert.equal((dotted.node as FileNode).content, 'nested');
  });

  it('resolves ".." that stays inside the sandbox', () => {
    const { tree, sandboxRoot } = makeTree();
    const resolver = new SandboxResolver(tree, sandboxRoot);
    const res = resolver.resolve('sub/deep/../../inner.txt');
    assert.equal((res.node as FileNode).content, 'inside');
  });

  it('rejects ".." that escapes the sandbox root', () => {
    const { tree, sandboxRoot } = makeTree();
    const resolver = new SandboxResolver(tree, sandboxRoot);
    assert.throws(() => resolver.resolve('../external/secret.txt'), SandboxEscapeError);
    assert.throws(() => resolver.resolve('sub/../../../external/secret.txt'), SandboxEscapeError);
  });

  it('reports missing files and non-directory traversal', () => {
    const { tree, sandboxRoot } = makeTree();
    const resolver = new SandboxResolver(tree, sandboxRoot);
    assert.throws(() => resolver.resolve('nope.txt'), NotFoundError);
    assert.throws(() => resolver.resolve('inner.txt/child'), NotDirectoryError);
  });
});

describe('SandboxResolver: symlink expansion', () => {
  it('follows a relative symlink against its containing directory', () => {
    const { tree, sandboxRoot } = makeTree();
    tree.symlink('deep/nested.txt', '/sandbox/sub/link');
    const resolver = new SandboxResolver(tree, sandboxRoot);
    const res = resolver.resolve('sub/link');
    assert.equal((res.node as FileNode).content, 'nested');
    assert.equal(res.expansions, 1);
  });

  it('follows symlink chains and keeps resolving the remainder', () => {
    const { tree, sandboxRoot } = makeTree();
    tree.symlink('sub', '/sandbox/a');
    tree.symlink('deep', '/sandbox/sub/b');
    tree.symlink('nested.txt', '/sandbox/sub/deep/c');
    const resolver = new SandboxResolver(tree, sandboxRoot);
    const res = resolver.resolve('a/b/c');
    assert.equal((res.node as FileNode).content, 'nested');
    assert.equal(res.expansions, 3);
  });

  it('rejects absolute symlink targets outside the sandbox', () => {
    const { tree, sandboxRoot } = makeTree();
    tree.symlink('/external/secret.txt', '/sandbox/evil');
    const resolver = new SandboxResolver(tree, sandboxRoot);
    assert.throws(() => resolver.resolve('evil'), SandboxEscapeError);
  });

  it('rejects relative symlink targets that climb out of the sandbox', () => {
    const { tree, sandboxRoot } = makeTree();
    tree.symlink('../../external/secret.txt', '/sandbox/sub/evil');
    const resolver = new SandboxResolver(tree, sandboxRoot);
    assert.throws(() => resolver.resolve('sub/evil'), SandboxEscapeError);
  });

  it('detects two-link loops', () => {
    const { tree, sandboxRoot } = makeTree();
    tree.symlink('b', '/sandbox/a');
    tree.symlink('a', '/sandbox/b');
    const resolver = new SandboxResolver(tree, sandboxRoot);
    assert.throws(() => resolver.resolve('a'), SymlinkLoopError);
  });

  it('detects self-referential loops', () => {
    const { tree, sandboxRoot } = makeTree();
    tree.symlink('self', '/sandbox/self');
    const resolver = new SandboxResolver(tree, sandboxRoot);
    assert.throws(() => resolver.resolve('self'), SymlinkLoopError);
  });

  it('enforces the expansion limit on non-looping chains', () => {
    const { tree, sandboxRoot } = makeTree();
    tree.symlink('l1', '/sandbox/l0');
    tree.symlink('l2', '/sandbox/l1');
    tree.symlink('l3', '/sandbox/l2');
    tree.symlink('inner.txt', '/sandbox/l3');
    const resolver = new SandboxResolver(tree, sandboxRoot, 3);
    assert.throws(() => resolver.resolve('l0'), TooManyExpansionsError);
    const generous = new SandboxResolver(tree, sandboxRoot, 4);
    assert.equal((generous.resolve('l0').node as FileNode).content, 'inside');
  });
});

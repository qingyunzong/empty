import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxEscapeError, SandboxFS, StaleGenerationError, VirtualFileTree, } from '../src/index.js';
function makeWorld() {
    const tree = new VirtualFileTree();
    tree.mkdir('/sandbox');
    tree.mkdir('/sandbox/data');
    tree.writeFile('/sandbox/data/report.txt', 'report-v1');
    tree.symlink('data/report.txt', '/sandbox/current');
    tree.mkdir('/external');
    tree.writeFile('/external/secret.txt', 'TOP-SECRET');
    const sandboxRoot = tree.getNode('/sandbox');
    if (sandboxRoot.kind !== 'dir')
        throw new Error('bad fixture');
    const fs = new SandboxFS(tree, sandboxRoot);
    const externalSecret = tree.getNode('/external/secret.txt');
    const report = tree.getNode('/sandbox/data/report.txt');
    return { tree, fs, externalSecret, report };
}
describe('SandboxFS: generation-bound check-then-open', () => {
    it('opens when the generation captured by exists() is unchanged', () => {
        const { fs, report } = makeWorld();
        const check = fs.exists('current');
        assert.equal(check.exists, true);
        const ticket = check.ticket;
        assert.equal(fs.open('current', ticket), 'report-v1');
        assert.equal(report.openCount, 1);
    });
    it('refuses to open after the symlink is swapped to an outside target', () => {
        const { tree, fs, externalSecret, report } = makeWorld();
        const check = fs.exists('current');
        assert.equal(check.exists, true);
        const ticket = check.ticket;
        // Attacker swaps the link between check and open.
        tree.retargetSymlink('/sandbox/current', '/external/secret.txt');
        assert.throws(() => fs.open('current', ticket), StaleGenerationError);
        // Proof: no outside object was ever opened.
        assert.equal(externalSecret.openCount, 0);
        assert.equal(report.openCount, 0);
    });
    it('refuses to open after the symlink is swapped to another inside file', () => {
        const { tree, fs, report } = makeWorld();
        tree.writeFile('/sandbox/data/other.txt', 'other');
        const { ticket } = fs.stat('current');
        tree.retargetSymlink('/sandbox/current', 'data/other.txt');
        assert.throws(() => fs.open('current', ticket), StaleGenerationError);
        assert.equal(report.openCount, 0);
    });
    it('detects swaps through intermediate directories', () => {
        const { tree, fs } = makeWorld();
        const { ticket } = fs.stat('data/report.txt');
        // Any mutation in a traversed directory (here /sandbox) bumps its generation.
        tree.retargetSymlink('/sandbox/current', 'data/report.txt'); // even a no-op retarget
        assert.throws(() => fs.open('data/report.txt', ticket), StaleGenerationError);
    });
    it('is not disturbed by mutations in unrelated directories', () => {
        const { tree, fs, report } = makeWorld();
        const { ticket } = fs.stat('data/report.txt');
        tree.writeFile('/external/unrelated.txt', 'noise');
        assert.equal(fs.open('data/report.txt', ticket), 'report-v1');
        assert.equal(report.openCount, 1);
    });
    it('rejects a ticket minted for a different path', () => {
        const { fs } = makeWorld();
        const { ticket } = fs.stat('data/report.txt');
        assert.throws(() => fs.open('current', ticket), StaleGenerationError);
    });
    it('without a ticket the boundary check still blocks escapes (defense in depth)', () => {
        const { tree, fs, externalSecret } = makeWorld();
        tree.retargetSymlink('/sandbox/current', '/external/secret.txt');
        assert.throws(() => fs.open('current'), SandboxEscapeError);
        assert.equal(externalSecret.openCount, 0);
    });
    it('exists() reports false for missing paths without throwing', () => {
        const { fs } = makeWorld();
        assert.deepEqual(fs.exists('data/missing.txt'), { exists: false });
    });
});

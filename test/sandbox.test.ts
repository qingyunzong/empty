import test from "node:test";
import assert from "node:assert/strict";
import { FsError, Sandbox, Vfs, symlink } from "../src/index.js";
import type { FileNode, LookupTicket } from "../src/index.js";

interface Fixture {
  vfs: Vfs;
  sandbox: Sandbox;
  secret: FileNode;
}

/**
 * Host tree:
 *   /sandbox/ok.txt            "inside"
 *   /sandbox/sub/deep.txt      "deep"
 *   /sandbox/sub/rel-link  ->  ../ok.txt
 *   /sandbox/abs-link      ->  /sandbox/ok.txt
 *   /sandbox/chain1        ->  chain2
 *   /sandbox/chain2        ->  /sandbox/ok.txt
 *   /sandbox/loop-a        ->  loop-b
 *   /sandbox/loop-b        ->  loop-a
 *   /sandbox/self          ->  self
 *   /sandbox/evil-abs      ->  /etc/secret
 *   /sandbox/evil-rel      ->  ../../etc/secret
 *   /sandbox/two-step      ->  sub/step2
 *   /sandbox/sub/step2     ->  /etc/secret
 *   /sandbox/swap          ->  ok.txt
 *   /etc/secret              "TOP-SECRET"
 */
function makeFixture(): Fixture {
  const vfs = new Vfs();
  vfs.mkdirp("/sandbox/sub");
  vfs.mkdirp("/etc");
  vfs.writeFile("/sandbox/ok.txt", "inside");
  vfs.writeFile("/sandbox/sub/deep.txt", "deep");
  vfs.addSymlink("/sandbox/sub/rel-link", "../ok.txt");
  vfs.addSymlink("/sandbox/abs-link", "/sandbox/ok.txt");
  vfs.addSymlink("/sandbox/chain1", "chain2");
  vfs.addSymlink("/sandbox/chain2", "/sandbox/ok.txt");
  vfs.addSymlink("/sandbox/loop-a", "loop-b");
  vfs.addSymlink("/sandbox/loop-b", "loop-a");
  vfs.addSymlink("/sandbox/self", "self");
  vfs.addSymlink("/sandbox/evil-abs", "/etc/secret");
  vfs.addSymlink("/sandbox/evil-rel", "../../etc/secret");
  vfs.addSymlink("/sandbox/two-step", "sub/step2");
  vfs.addSymlink("/sandbox/sub/step2", "/etc/secret");
  vfs.addSymlink("/sandbox/swap", "ok.txt");
  const secret = vfs.writeFile("/etc/secret", "TOP-SECRET");
  return { vfs, sandbox: new Sandbox(vfs, "/sandbox"), secret };
}

function expectFsError(code: string, fn: () => unknown): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof FsError && err.code === code,
    `expected FsError ${code}`,
  );
}

function mustExist(sandbox: Sandbox, path: string): LookupTicket {
  const ticket = sandbox.exists(path);
  if (ticket === null) throw new Error(`expected ${path} to exist`);
  return ticket;
}

test("resolves relative paths with . and ..", () => {
  const { sandbox } = makeFixture();
  assert.equal(sandbox.readFile("ok.txt"), "inside");
  assert.equal(sandbox.readFile("./sub/deep.txt"), "deep");
  assert.equal(sandbox.readFile("sub/../ok.txt"), "inside");
  assert.equal(sandbox.readFile("/sub/deep.txt"), "deep");
});

test("'..' clamps at the sandbox root instead of escaping", () => {
  const { sandbox } = makeFixture();
  assert.equal(sandbox.readFile("../../ok.txt"), "inside");
  assert.equal(sandbox.readFile("sub/../../../ok.txt"), "inside");
});

test("expands relative, absolute and chained symlinks inside the sandbox", () => {
  const { sandbox } = makeFixture();
  assert.equal(sandbox.readFile("sub/rel-link"), "inside");
  assert.equal(sandbox.readFile("abs-link"), "inside");
  assert.equal(sandbox.readFile("chain1"), "inside");
});

test("rejects absolute symlink targets outside the sandbox", () => {
  const { sandbox, secret } = makeFixture();
  expectFsError("ESCAPE", () => sandbox.readFile("evil-abs"));
  assert.equal(secret.openCount, 0);
});

test("rejects relative symlink targets that climb out of the sandbox", () => {
  const { sandbox, secret } = makeFixture();
  expectFsError("ESCAPE", () => sandbox.readFile("evil-rel"));
  assert.equal(secret.openCount, 0);
});

test("checks the boundary at every expansion step (mid-chain escape)", () => {
  const { sandbox, secret } = makeFixture();
  // two-step -> sub/step2 (inside, passes step 1) -> /etc/secret (caught at step 2)
  expectFsError("ESCAPE", () => sandbox.readFile("two-step"));
  assert.equal(secret.openCount, 0);
});

test("detects symlink cycles (ELOOP)", () => {
  const { sandbox } = makeFixture();
  expectFsError("ELOOP", () => sandbox.readFile("loop-a"));
  expectFsError("ELOOP", () => sandbox.readFile("self"));
});

test("enforces the expansion-count limit (EMLINK)", () => {
  const vfs = new Vfs();
  vfs.mkdirp("/sandbox");
  vfs.writeFile("/sandbox/target.txt", "x");
  for (let n = 0; n < 5; n++) {
    const next = n === 4 ? "target.txt" : `link${n + 1}`;
    vfs.addSymlink(`/sandbox/link${n}`, next);
  }
  const limited = new Sandbox(vfs, "/sandbox", { maxExpansions: 3 });
  expectFsError("EMLINK", () => limited.readFile("link0"));
  const enough = new Sandbox(vfs, "/sandbox", { maxExpansions: 5 });
  assert.equal(enough.readFile("link0"), "x");
});

test("exists() returns a ticket for present paths and null for missing ones", () => {
  const { sandbox } = makeFixture();
  const ticket = mustExist(sandbox, "sub/rel-link");
  assert.equal(ticket.resolved, "/sandbox/ok.txt");
  assert.equal(ticket.kind, "file");
  assert.equal(sandbox.exists("nope.txt"), null);
  assert.equal(sandbox.exists("ok.txt/nope"), null);
});

test("exists() still surfaces boundary errors instead of returning null", () => {
  const { sandbox } = makeFixture();
  expectFsError("ESCAPE", () => sandbox.exists("evil-abs"));
});

test("open() accepts a ticket from exists() when nothing changed", () => {
  const { sandbox } = makeFixture();
  const ticket = mustExist(sandbox, "swap");
  assert.equal(sandbox.readFile("swap", ticket), "inside");
});

test("ESTALE: swapping a link to an external target between check and open", () => {
  const { vfs, sandbox, secret } = makeFixture();
  const ticket = mustExist(sandbox, "swap");
  // Attacker swaps /sandbox/swap to point outside the sandbox.
  vfs.replace("/sandbox/swap", symlink("/etc/secret"));
  expectFsError("ESTALE", () => sandbox.readFile("swap", ticket));
  // The external object was never opened.
  assert.equal(secret.openCount, 0);
});

test("ESTALE: swapping a link to a different internal file is also rejected", () => {
  const { vfs, sandbox } = makeFixture();
  const ticket = mustExist(sandbox, "swap");
  vfs.replace("/sandbox/swap", symlink("sub/deep.txt"));
  expectFsError("ESTALE", () => sandbox.readFile("swap", ticket));
});

test("without a ticket the swapped external link is stopped by the boundary check", () => {
  const { vfs, sandbox, secret } = makeFixture();
  vfs.replace("/sandbox/swap", symlink("/etc/secret"));
  expectFsError("ESCAPE", () => sandbox.readFile("swap"));
  assert.equal(secret.openCount, 0);
});

test("ESTALE: removing and recreating an entry invalidates the ticket", () => {
  const { vfs, sandbox } = makeFixture();
  const ticket = mustExist(sandbox, "ok.txt");
  vfs.remove("/sandbox/ok.txt");
  vfs.writeFile("/sandbox/ok.txt", "forged");
  expectFsError("ESTALE", () => sandbox.readFile("ok.txt", ticket));
  // A fresh check+open pair on the recreated file works.
  const fresh = mustExist(sandbox, "ok.txt");
  assert.equal(sandbox.readFile("ok.txt", fresh), "forged");
});

test("open() reports ENOENT for missing files and EISDIR for directories", () => {
  const { sandbox } = makeFixture();
  expectFsError("ENOENT", () => sandbox.readFile("missing.txt"));
  expectFsError("EISDIR", () => sandbox.readFile("sub"));
});

import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReplicaRegistry } from "../src/registry.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "registrytest-"));
}

test("deregistration is persistently recorded in the epoch log", () => {
  const dir = tmpdir();
  const reg = ReplicaRegistry.open(dir);
  reg.register("r1", 0);
  reg.register("r2", 5);
  reg.ack("r1", 7);
  reg.deregister("r2");

  strictEqual(reg.currentEpoch, 3);
  deepStrictEqual(reg.members(), ["r1"]);

  // Reopen: the departed replica stays gone; its ack cannot block compaction.
  const reopened = ReplicaRegistry.open(dir);
  deepStrictEqual(reopened.members(), ["r1"]);
  strictEqual(reopened.ackOf("r1"), 7);
  strictEqual(reopened.currentEpoch, 3);
  throws(() => reopened.ackOf("r2"));

  const history = reopened.epochHistory();
  strictEqual(history.length, 3);
  const last = history[2]!;
  strictEqual(last.kind, "deregister");
  strictEqual(last.replicaId, "r2");
  strictEqual(last.epoch, 3);
  deepStrictEqual(last.members, ["r1"]);

  // Epochs keep increasing after recovery.
  reopened.register("r3", 9);
  strictEqual(reopened.currentEpoch, 4);
  strictEqual(reopened.ackOf("r3"), 9);
});

test("ack is monotonic and membership is enforced", () => {
  const dir = tmpdir();
  const reg = ReplicaRegistry.open(dir);
  reg.register("r1", 3);
  reg.ack("r1", 8);
  strictEqual(reg.ackOf("r1"), 8);
  throws(() => reg.ack("r1", 4));
  throws(() => reg.ack("ghost", 1));
  throws(() => reg.register("r1", 0));
  throws(() => reg.deregister("ghost"));
  deepStrictEqual(reg.ackVector().get("r1"), 8);
});

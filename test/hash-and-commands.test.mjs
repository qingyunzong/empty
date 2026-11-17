import test from "node:test";
import assert from "node:assert/strict";

import {
  CommandCatalog,
  CrossSlotError,
  RedisReplyError,
  crc16,
  commandKeys,
  keySlot,
  prepareCommand,
} from "../build/src/index.js";

test("Redis error replies normalize an optional leading dash", () => {
  const error = new RedisReplyError("-MOVED 3999 10.0.0.2:7000");
  assert.equal(error.code, "MOVED");
  assert.equal(error.reply, "MOVED 3999 10.0.0.2:7000");
});

test("CRC16 and Redis Cluster hash slots match known values", () => {
  assert.equal(crc16("123456789"), 0x31c3);
  assert.equal(keySlot("foo"), 12182);
  assert.equal(keySlot("bar"), 5061);
  assert.equal(keySlot("hello"), 866);
});

test("hash tags use only the first non-empty brace pair", () => {
  assert.equal(keySlot("{user1000}.following"), keySlot("{user1000}.followers"));
  assert.equal(keySlot("foo{bar}{zap}"), keySlot("bar"));
  assert.notEqual(keySlot("{}foo"), keySlot("foo"));
  assert.notEqual(keySlot("foo{}{bar}"), keySlot("bar"));
});

test("multi-key commands expose all keys and same-slot hash tags are accepted", () => {
  assert.deepEqual(commandKeys({ name: "MSET", args: ["a", "1", "b", "2"] }), ["a", "b"]);
  assert.deepEqual(commandKeys({ name: "DEL", args: ["a", "b", "c"] }), ["a", "b", "c"]);
  assert.deepEqual(commandKeys({ name: "EVAL", args: ["2", "a", "b", "return 1"] }), ["a", "b"]);
  assert.deepEqual(commandKeys({ name: "SORT", args: ["src", "STORE", "dst"] }), ["src", "dst"]);
  assert.deepEqual(commandKeys({ name: "GEORADIUS", args: ["src", "0", "0", "1", "km", "STORE", "dst"] }), [
    "src",
    "dst",
  ]);
  assert.deepEqual(commandKeys({ name: "LMPOP", args: ["2", "a", "b", "LEFT"] }), ["a", "b"]);
  assert.deepEqual(commandKeys({ name: "XINFO", args: ["STREAM", "events"] }), ["events"]);

  const sameSlot = prepareCommand({
    name: "MSET",
    args: ["{tenant:42}:a", "1", "{tenant:42}:b", "2"],
  });
  assert.equal(sameSlot.keys.length, 2);
  assert.equal(sameSlot.slot, keySlot("{tenant:42}:a"));
});

test("a cross-slot command is rejected synchronously during preparation", () => {
  assert.throws(
    () => prepareCommand({ name: "MSET", args: ["first", "1", "second", "2"] }),
    (error) => {
      assert.ok(error instanceof CrossSlotError);
      assert.equal(error.code, "CROSS_SLOT");
      assert.deepEqual(error.keys, ["first", "second"]);
      return true;
    },
  );
});

test("custom command metadata and explicit keys can be embedded", () => {
  const catalog = new CommandCatalog({
    EXTENSION: { keys: { firstKey: 1, lastKey: 2 }, idempotent: true },
  });

  const prepared = prepareCommand(
    { name: "extension", args: ["ignored", "{x}:1", "{x}:2"] },
    catalog,
  );
  assert.equal(prepared.idempotent, true);
  assert.deepEqual(prepared.keys, ["{x}:1", "{x}:2"]);

  const explicit = prepareCommand({
    name: "CUSTOM",
    args: ["{x}:a", "{x}:b"],
    keys: ["{x}:a", "{x}:b"],
  });
  assert.deepEqual(explicit.keys, ["{x}:a", "{x}:b"]);
});

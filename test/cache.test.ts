import * as assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CacheStore, PowerFailure, atomicWriteFileSync } from "../src/index.js";
import { makeFixture } from "./helpers.js";

test("缓存记录: 写入后可读回，校验和自验证", () => {
  const fx = makeFixture();
  const store = new CacheStore(fx.cacheDir);
  store.write({ stage: "s1", digest: "d1", outputHash: "h1", output: { n: 42 } });
  const back = store.read("s1");
  assert.deepEqual(back, { stage: "s1", digest: "d1", outputHash: "h1", output: { n: 42 } });
  assert.equal(store.read("missing"), null);
});

test("缓存记录: 被篡改/截断的记录视为未命中并清除", () => {
  const fx = makeFixture();
  const store = new CacheStore(fx.cacheDir);
  store.write({ stage: "s1", digest: "d1", outputHash: "h1", output: "v" });
  const file = join(fx.cacheDir, "s1.json");

  const tampered = readFileSync(file, "utf8").replace("d1", "XX");
  writeFileSync(file, tampered);
  assert.equal(store.read("s1"), null, "校验和不匹配 -> 未命中");
  assert.equal(existsSync(file), false, "损坏记录被删除");

  store.write({ stage: "s1", digest: "d1", outputHash: "h1", output: "v" });
  writeFileSync(file, readFileSync(file, "utf8").slice(0, 12)); // 截断
  assert.equal(store.read("s1"), null);
  assert.equal(existsSync(file), false);
});

test("原子发布: 提交后无临时文件残留；崩溃遗留的 tmp 被清理", () => {
  const fx = makeFixture();
  const store = new CacheStore(fx.cacheDir);
  store.write({ stage: "s1", digest: "d", outputHash: "h", output: 1 });
  store.write({ stage: "s2", digest: "d", outputHash: "h", output: 2 });
  assert.deepEqual(readdirSync(fx.cacheDir).sort(), ["s1.json", "s2.json"]);

  writeFileSync(join(fx.cacheDir, ".tmp.123.0"), "partial");
  const removed = store.cleanOrphans();
  assert.deepEqual(removed, [".tmp.123.0"]);
  assert.deepEqual(readdirSync(fx.cacheDir).sort(), ["s1.json", "s2.json"]);
});

test("原子发布: tmp 写入后、rename 前断电 -> 目标文件不出现", () => {
  const fx = makeFixture();
  const crashing = new CacheStore(fx.cacheDir, {
    afterTmpWrite: () => {
      throw new PowerFailure("power cut before rename");
    },
  });
  assert.throws(
    () => crashing.write({ stage: "s1", digest: "d", outputHash: "h", output: "v" }),
    (err) => err instanceof PowerFailure,
  );
  assert.equal(existsSync(join(fx.cacheDir, "s1.json")), false, "rename 未发生，无半成品结果");
  assert.equal(readdirSync(fx.cacheDir).filter((f) => f.startsWith(".tmp.")).length, 1, "tmp 孤儿留待清理");

  const recovered = new CacheStore(fx.cacheDir);
  assert.equal(recovered.read("s1"), null, "崩溃前的部分写入不可复用");
});

test("原子发布: rename 之后断电 -> 完整记录可读（rename 是原子提交点）", () => {
  const fx = makeFixture();
  const crashing = new CacheStore(fx.cacheDir, {
    afterRename: () => {
      throw new PowerFailure("power cut after rename");
    },
  });
  assert.throws(() => crashing.write({ stage: "s1", digest: "d", outputHash: "h", output: "v" }), PowerFailure);
  const recovered = new CacheStore(fx.cacheDir);
  assert.deepEqual(recovered.read("s1"), { stage: "s1", digest: "d", outputHash: "h", output: "v" });
});

test("atomicWriteFileSync: 通用原子发布同样抵御中途断电", () => {
  const fx = makeFixture();
  const target = join(fx.dir, "report.json");
  assert.throws(
    () =>
      atomicWriteFileSync(target, "{\"ok\":true}", {
        afterTmpWrite: () => {
          throw new PowerFailure("cut");
        },
      }),
    PowerFailure,
  );
  assert.equal(existsSync(target), false);
  atomicWriteFileSync(target, "{\"ok\":true}");
  assert.equal(readFileSync(target, "utf8"), "{\"ok\":true}");
});

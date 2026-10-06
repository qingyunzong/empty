import test from "node:test";
import assert from "node:assert/strict";
import {
  CircularReferenceError,
  ConfigStore,
  MissingKeyError,
} from "../src/config.js";

test("递归展开嵌套占位符", () => {
  const store = new ConfigStore();
  store
    .set("host", "example.com")
    .set("port", "8080")
    .set("base", "http://${host}:${port}")
    .set("api", "${base}/v1");
  assert.equal(store.get("api"), "http://example.com:8080/v1");
});

test("缺键抛出 MissingKeyError 而非空串", () => {
  const store = new ConfigStore();
  store.set("a", "x-${missing}-y");
  assert.throws(() => store.get("a"), (err: unknown) => {
    assert.ok(err instanceof MissingKeyError);
    assert.equal(err.key, "missing");
    assert.deepEqual(err.path, ["a", "missing"]);
    return true;
  });
  // 直接请求缺键
  assert.throws(() => store.get("nope"), MissingKeyError);
});

test("转义占位保持字面量", () => {
  const store = new ConfigStore();
  store.set("key", "real");
  store.set("esc", "\\${key}");
  store.set("mix", "a\\${key}b ${key}c");
  assert.equal(store.get("esc"), "${key}");
  assert.equal(store.get("mix"), "a${key}b realc");
});

test("未闭合占位按字面量处理", () => {
  const store = new ConfigStore();
  store.set("s", "abc ${oops");
  assert.equal(store.get("s"), "abc ${oops");
});

test("循环引用报错，路径从请求键开始", () => {
  const store = new ConfigStore();
  store.set("a", "${b}");
  store.set("b", "${c}");
  store.set("c", "${a}");
  assert.throws(() => store.get("a"), (err: unknown) => {
    assert.ok(err instanceof CircularReferenceError);
    assert.deepEqual(err.path, ["a", "b", "c", "a"]);
    assert.match(err.message, /a -> b -> c -> a/);
    return true;
  });
  // 自引用
  store.set("self", "${self}");
  assert.throws(() => store.get("self"), (err: unknown) => {
    assert.ok(err instanceof CircularReferenceError);
    assert.deepEqual(err.path, ["self", "self"]);
    return true;
  });
});

test("缓存：修改后仅依赖项失效", () => {
  const store = new ConfigStore();
  store
    .set("host", "a.com")
    .set("base", "http://${host}")
    .set("api", "${base}/v1")
    .set("standalone", "plain");

  // 建立缓存
  assert.equal(store.get("api"), "http://a.com/v1");
  assert.equal(store.get("standalone"), "plain");
  assert.ok(store.isCacheFresh("api"));
  assert.ok(store.isCacheFresh("base"));
  assert.ok(store.isCacheFresh("standalone"));

  // 修改 host：依赖链上的 api/base 失效，standalone 保持新鲜
  store.set("host", "b.com");
  assert.ok(!store.isCacheFresh("api"));
  assert.ok(!store.isCacheFresh("base"));
  assert.ok(store.isCacheFresh("standalone"));

  assert.equal(store.get("api"), "http://b.com/v1");
  assert.ok(store.isCacheFresh("api"));
});

test("缓存结果与无缓存解析一致（对照）", () => {
  const store = new ConfigStore();
  store
    .set("x", "1")
    .set("y", "${x}2")
    .set("z", "${y}3")
    .set("w", "${z}-${y}-${x}");

  const keys = ["x", "y", "z", "w"];
  const checkAll = () => {
    for (const k of keys) {
      assert.equal(store.get(k), store.getUncached(k), `key=${k}`);
    }
  };

  checkAll(); // 冷缓存
  checkAll(); // 热缓存

  // 多轮修改后仍一致
  store.set("x", "10");
  checkAll();
  store.set("y", "Y${x}");
  checkAll();
  assert.equal(store.get("w"), "Y103-Y10-10");
});

test("覆盖占位定义后缓存随之更新", () => {
  const store = new ConfigStore();
  store.set("name", "world").set("greet", "hi ${name}");
  assert.equal(store.get("greet"), "hi world");
  store.set("name", "ts");
  assert.equal(store.get("greet"), "hi ts");
  assert.equal(store.get("greet"), store.getUncached("greet"));
});

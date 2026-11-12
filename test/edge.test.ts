// @ts-nocheck
/**
 * 规则边界测试。期望值仍按公式手工写出，不依赖被测函数生成。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CacheDecider, decideCache } from "../index.js";

const BASE = 1704067200; // Mon, 01 Jan 2024 00:00:00 GMT
const BASE_HTTP = "Mon, 01 Jan 2024 00:00:00 GMT";

const h = (name, value) => ({ name, value });
const req = (method, headers = []) => ({ method, headers });
const stored = (overrides = {}) => ({
  status: overrides.status ?? 200,
  headers: overrides.headers ?? [],
  responseTime: overrides.responseTime ?? BASE,
  requestTime: overrides.requestTime ?? BASE,
  storedRequest: overrides.storedRequest ?? req("GET"),
});
const lookup = (request, storedResponse, now) => ({ request, stored: storedResponse, now });
const cc = (value) => h("Cache-Control", value);

function expectEmptyNumbers(verdict) {
  assert.equal(verdict.age, null);
  assert.equal(verdict.lifetime, null);
  assert.equal(verdict.staleFor, null);
  assert.equal(verdict.needOverLifetime, null);
}

test("方法：仅 GET/HEAD 命中，HEAD 存储只能服务 HEAD", () => {
  const shared = new CacheDecider("shared", false);
  const getStored = stored({ headers: [cc("max-age=100")] });

  assert.equal(shared.decide(lookup(req("HEAD"), getStored, BASE + 10)).decision, "fresh");
  assert.equal(shared.decide(lookup(req("POST"), getStored, BASE + 10)).decision, "miss");

  const headStored = stored({
    headers: [cc("max-age=100")],
    storedRequest: req("HEAD"),
  });
  assert.equal(shared.decide(lookup(req("HEAD"), headStored, BASE + 10)).decision, "fresh");
  assert.equal(shared.decide(lookup(req("GET"), headStored, BASE + 10)).decision, "miss");

  // 方法名按 ASCII 大小写归一。
  assert.equal(shared.decide(lookup(req("get"), getStored, BASE + 10)).decision, "fresh");
});

test("no-store：请求或响应都硬未命中", () => {
  const shared = new CacheDecider("shared", false);
  const requestNoStore = shared.decide(
    lookup(req("GET", [cc("no-store")]), stored({ headers: [cc("max-age=100")] }), BASE + 10),
  );
  assert.equal(requestNoStore.decision, "miss");
  assert.equal(requestNoStore.reason, "miss-request-no-store");
  expectEmptyNumbers(requestNoStore);

  const responseNoStore = shared.decide(
    lookup(req("GET"), stored({ headers: [cc("no-store, max-age=100")] }), BASE + 10),
  );
  assert.equal(responseNoStore.reason, "miss-response-no-store");
  expectEmptyNumbers(responseNoStore);
});

test("时刻健全性与重复头", () => {
  const shared = new CacheDecider("shared", false);

  assert.equal(
    shared.decide(
      lookup(
        req("GET"),
        stored({ requestTime: BASE + 5, responseTime: BASE, headers: [cc("max-age=100")] }),
        BASE + 10,
      ),
    ).reason,
    "miss-response-before-request",
  );

  assert.equal(
    shared.decide(
      lookup(req("GET"), stored({ headers: [cc("max-age=100")] }), BASE - 1),
    ).reason,
    "miss-now-before-response",
  );

  const multipleAge = shared.decide(
    lookup(
      req("GET"),
      stored({ headers: [h("Age", "1"), h("Age", "2"), cc("max-age=100")] }),
      BASE + 10,
    ),
  );
  assert.equal(multipleAge.reason, "miss-multiple-age");
  expectEmptyNumbers(multipleAge);

  const multipleDate = shared.decide(
    lookup(
      req("GET"),
      stored({
        headers: [h("Date", BASE_HTTP), h("Date", BASE_HTTP), cc("max-age=100")],
      }),
      BASE + 10,
    ),
  );
  assert.equal(multipleDate.reason, "miss-multiple-date");
});

test("Cache-Control 解析：引号、转义、未闭合、重复指令", () => {
  const shared = new CacheDecider("shared", false);

  // 引号内逗号不分隔，反斜杠转义后一字符；整体仍是未知/带值 private，不影响 max-age。
  const quoted = shared.decide(
    lookup(
      req("GET"),
      stored({
        headers: [cc('no-cache="a\\",b", max-age=100'), h("ETag", '"x"')],
      }),
      BASE + 10,
    ),
  );
  assert.equal(quoted.decision, "revalidate");
  assert.equal(quoted.reason, "revalidate-response-no-cache");

  // 引号不闭合 -> 硬未命中。
  const unclosed = shared.decide(
    lookup(req("GET"), stored({ headers: [cc('max-age=100, no-cache="x')] }), BASE + 10),
  );
  assert.equal(unclosed.decision, "miss");
  expectEmptyNumbers(unclosed);

  // 重复指令只取第一个：第一个 max-age=50 生效。
  const duplicate = shared.decide(
    lookup(
      req("GET"),
      stored({ headers: [cc("max-age=50, max-age=9999")] }),
      BASE + 10,
    ),
  );
  assert.equal(duplicate.lifetime, 50);

  // 第一个值非法 -> 未命中，即使第二个合法。
  const firstBad = shared.decide(
    lookup(req("GET"), stored({ headers: [cc("max-age=abc, max-age=50")] }), BASE + 10),
  );
  assert.equal(firstBad.decision, "miss");
  expectEmptyNumbers(firstBad);

  // 未知指令忽略。
  const unknown = shared.decide(
    lookup(req("GET"), stored({ headers: [cc("foo=bar, max-age=100")] }), BASE + 10),
  );
  assert.equal(unknown.decision, "fresh");

  // 前导零与边界值 2147483647 合法；越界非法。
  const leadingZero = shared.decide(
    lookup(req("GET"), stored({ headers: [cc("max-age=007")] }), BASE + 5),
  );
  assert.equal(leadingZero.lifetime, 7);

  const boundary = shared.decide(
    lookup(req("GET"), stored({ headers: [cc("max-age=2147483647")] }), BASE + 5),
  );
  assert.equal(boundary.decision, "fresh");

  const overBoundary = shared.decide(
    lookup(req("GET"), stored({ headers: [cc("max-age=2147483648")] }), BASE + 5),
  );
  assert.equal(overBoundary.decision, "miss");
});

test("状态可缓存性与校验器", () => {
  const shared = new CacheDecider("shared", false);

  // 201 不在默认集合，又无 public/max-age/s-maxage -> 硬未命中。
  const plain201 = shared.decide(
    lookup(req("GET"), stored({ status: 201, headers: [cc("max-stale=9999")] }), BASE + 10),
  );
  assert.equal(plain201.reason, "miss-status-not-cacheable");
  expectEmptyNumbers(plain201);

  // 201 + public 允许存储；寿命 0，年龄 0 -> need=0<=0 fresh。
  const public201 = shared.decide(
    lookup(req("GET"), stored({ status: 201, headers: [cc("public")] }), BASE),
  );
  assert.equal(public201.decision, "fresh");

  // revalidate 且无 ETag/Last-Modified -> miss。
  const noValidator = shared.decide(
    lookup(req("GET"), stored({ headers: [cc("max-age=0")] }), BASE + 1),
  );
  assert.equal(noValidator.decision, "miss");
  assert.equal(noValidator.reason, "miss-no-validator");

  // 有有效 Last-Modified 即可保留 revalidate。
  const withValidator = shared.decide(
    lookup(
      req("GET"),
      stored({
        headers: [cc("max-age=0"), h("Date", BASE_HTTP), h("Last-Modified", "Sun, 31 Dec 2023 23:59:35 GMT")],
      }),
      BASE + 1,
    ),
  );
  assert.equal(withValidator.decision, "revalidate");
});

test("便捷函数与不修改入参", () => {
  const input = lookup(
    req("GET", [cc("max-age=100")]),
    stored({ headers: [cc("max-age=100")] }),
    BASE + 10,
  );
  const before = JSON.parse(JSON.stringify(input));
  const verdict = decideCache("shared", false, input);
  assert.equal(verdict.decision, "fresh");
  assert.deepEqual(input, before);
});

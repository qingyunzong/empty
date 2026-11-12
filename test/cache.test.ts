// @ts-nocheck
/**
 * 独立算术表：每个期望值都按规格公式手工计算后写成字面量，
 * 不调用被测函数来制造期望。时间以固定锚点 BASE=1704067200
 * （Mon, 01 Jan 2024 00:00:00 GMT）做整数偏移，便于逐行核对。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CacheDecider } from "../index.js";

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

const snapshot = (value) => JSON.parse(JSON.stringify(value));

function expectNumbers(verdict, age, lifetime, staleFor, needOverLifetime) {
  assert.equal(verdict.age, age, "age");
  assert.equal(verdict.lifetime, lifetime, "lifetime");
  assert.equal(verdict.staleFor, staleFor, "staleFor");
  assert.equal(verdict.needOverLifetime, needOverLifetime, "needOverLifetime");
}

function expectDeterministic(decider, input) {
  assert.deepEqual(decider.decide(input), decider.decide(input));
}

test("A. 响应延迟：corrected 与 apparent 两条年龄路径", () => {
  const shared = new CacheDecider("shared", false);

  // requestTime=BASE, responseTime=BASE+10, now=BASE+30，无 Age 无 Date：
  // corrected=0+10=10，apparent=0，初始年龄=10，当前年龄=10+(30-10)=30。
  const input1 = lookup(
    req("GET", [cc("max-age=100")]),
    stored({ requestTime: BASE, responseTime: BASE + 10, headers: [cc("max-age=100")] }),
    BASE + 30,
  );
  const before1 = snapshot(input1);
  const v1 = shared.decide(input1);
  assert.equal(v1.decision, "fresh");
  expectNumbers(v1, 30, 100, 0, 0);
  assert.equal(v1.reason, "fresh-within-lifetime");
  assert.deepEqual(input1, before1);
  expectDeterministic(shared, input1);

  // Age=25：corrected=25+10=35 占优；当前年龄=35+20=55。
  const input2 = lookup(
    req("GET"),
    stored({
      requestTime: BASE,
      responseTime: BASE + 10,
      headers: [h("Age", "25"), cc("max-age=100")],
    }),
    BASE + 30,
  );
  const v2 = shared.decide(input2);
  assert.equal(v2.decision, "fresh");
  expectNumbers(v2, 55, 100, 0, 0);

  // Date=BASE-40，响应时刻 BASE+10：apparent=(BASE+10)-(BASE-40)=50 > corrected=10，
  // 初始年龄=50，当前年龄=50+20=70；寿命 50 -> revalidate，带 ETag 可校验。
  const input3 = lookup(
    req("GET"),
    stored({
      requestTime: BASE,
      responseTime: BASE + 10,
      headers: [
        h("Date", "Sun, 31 Dec 2023 23:59:20 GMT"), // BASE-40
        cc("max-age=50"),
        h("ETag", '"v1"'),
      ],
    }),
    BASE + 30,
  );
  const v3 = shared.decide(input3);
  assert.equal(v3.decision, "revalidate");
  expectNumbers(v3, 70, 50, 20, 20);
});

test("B. 两种缓存对 s-maxage 的差异", () => {
  const headers = [cc("max-age=100, s-maxage=5")];
  const input = lookup(
    req("GET"),
    stored({ requestTime: BASE, responseTime: BASE, headers }),
    BASE + 10,
  );

  // 共享缓存采用 s-maxage=5：年龄 10 > 5 -> revalidate，无校验器 -> miss。
  const sharedVerdict = new CacheDecider("shared", false).decide(input);
  assert.equal(sharedVerdict.decision, "miss");
  expectNumbers(sharedVerdict, 10, 5, 5, 5);
  assert.equal(sharedVerdict.reason, "miss-no-validator");

  // 私有缓存忽略 s-maxage，采用 max-age=100：fresh。
  const privateVerdict = new CacheDecider("private", false).decide(input);
  assert.equal(privateVerdict.decision, "fresh");
  expectNumbers(privateVerdict, 10, 100, 0, 0);

  // s-maxage 非法：两种缓存都硬未命中，四个数字为空。
  const badInput = lookup(
    req("GET"),
    stored({ headers: [cc("max-age=100, s-maxage=99999999999")] }),
    BASE + 10,
  );
  assert.equal(new CacheDecider("shared", false).decide(badInput).decision, "miss");
  const badShared = new CacheDecider("shared", false).decide(badInput);
  const bad = new CacheDecider("private", false).decide(badInput);
  assert.equal(bad.decision, "miss");
  expectNumbers(bad, null, null, null, null);
  expectNumbers(badShared, null, null, null, null);
});

test("C. min-fresh 与 max-stale 同时生效", () => {
  const shared = new CacheDecider("shared", false);
  const baseStored = stored({ headers: [cc("max-age=10"), h("ETag", '"x"')] });

  // 年龄=寿命=10：min-fresh=5 -> need=15；max-stale=5 -> 15<=15 -> stale。
  const staleVerdict = shared.decide(
    lookup(req("GET", [cc("min-fresh=5, max-stale=5")]), baseStored, BASE + 10),
  );
  assert.equal(staleVerdict.decision, "stale");
  expectNumbers(staleVerdict, 10, 10, 0, 5);

  // min-fresh=6 -> need=16；max-stale=5 -> 16>15 -> revalidate。
  const revalidateVerdict = shared.decide(
    lookup(req("GET", [cc("min-fresh=6, max-stale=5")]), baseStored, BASE + 10),
  );
  assert.equal(revalidateVerdict.decision, "revalidate");
  expectNumbers(revalidateVerdict, 10, 10, 0, 6);

  // 无值 max-stale 接受任意陈旧：need=10+190=200 仍 stale。
  const infiniteVerdict = shared.decide(
    lookup(
      req("GET", [cc("min-fresh=190"), cc("max-stale")]),
      baseStored,
      BASE + 10,
    ),
  );
  assert.equal(infiniteVerdict.decision, "stale");
  expectNumbers(infiniteVerdict, 10, 10, 0, 190);

  // must-revalidate 优先，max-stale 无法改写成 stale。
  const mustVerdict = shared.decide(
    lookup(
      req("GET", [cc("max-stale=100")]),
      stored({ headers: [cc("max-age=10, must-revalidate"), h("ETag", '"x"')] }),
      BASE + 10,
    ),
  );
  assert.equal(mustVerdict.decision, "revalidate");
  assert.equal(mustVerdict.reason, "revalidate-must-revalidate");
});

test("D. only-if-cached", () => {
  const shared = new CacheDecider("shared", false);

  // fresh 不受影响。
  const freshVerdict = shared.decide(
    lookup(
      req("GET", [cc("only-if-cached")]),
      stored({ headers: [cc("max-age=100")] }),
      BASE + 10,
    ),
  );
  assert.equal(freshVerdict.decision, "fresh");
  expectNumbers(freshVerdict, 10, 100, 0, 0);

  // 已接受的 stale 不变。
  const staleVerdict = shared.decide(
    lookup(
      req("GET", [cc("only-if-cached, max-stale=100")]),
      stored({ headers: [cc("max-age=5")] }),
      BASE + 10,
    ),
  );
  assert.equal(staleVerdict.decision, "stale");

  // revalidate 被 only-if-cached 改为 miss，数字仍按公式给出。
  const missVerdict = shared.decide(
    lookup(
      req("GET", [cc("only-if-cached")]),
      stored({ headers: [cc("max-age=5"), h("ETag", '"x"')] }),
      BASE + 10,
    ),
  );
  assert.equal(missVerdict.decision, "miss");
  assert.equal(missVerdict.reason, "miss-only-if-cached");
  expectNumbers(missVerdict, 10, 5, 5, 5);
});

test("E. Vary：星号与逐字段原始值比较", () => {
  const shared = new CacheDecider("shared", false);
  const base = {
    headers: [h("Vary", "Accept-Encoding"), cc("max-age=100")],
    storedRequest: req("GET", [h("Accept-Encoding", "gzip")]),
  };

  assert.equal(shared.decide(lookup(req("GET", [h("Accept-Encoding", "gzip")]), stored(base), BASE + 10)).decision, "fresh");

  const mismatch = shared.decide(lookup(req("GET", [h("Accept-Encoding", "br")]), stored(base), BASE + 10));
  assert.equal(mismatch.decision, "miss");
  expectNumbers(mismatch, null, null, null, null);

  assert.equal(
    shared.decide(lookup(req("GET"), stored({ headers: [h("Vary", "*"), cc("max-age=100")] }), BASE + 10)).reason,
    "miss-vary-mismatch",
  );

  // 多个同名头按序用逗号直接连接。
  const multiStored = stored({
    headers: [h("Vary", "X-Lang"), cc("max-age=100")],
    storedRequest: req("GET", [h("X-Lang", "en"), h("X-Lang", "fr")]),
  });
  assert.equal(
    shared.decide(
      lookup(req("GET", [h("X-Lang", "en"), h("X-Lang", "fr")]), multiStored, BASE + 10),
    ).decision,
    "fresh",
  );

  // 区分大小写："Gzip" != "gzip"。
  assert.equal(
    shared.decide(lookup(req("GET", [h("Accept-Encoding", "Gzip")]), stored(base), BASE + 10)).decision,
    "miss",
  );

  // 新请求缺头：空串 != "gzip"。
  assert.equal(shared.decide(lookup(req("GET"), stored(base), BASE + 10)).decision, "miss");
});

test("F. 启发式寿命的整除下限", () => {
  // Date=BASE，Last-Modified=BASE-25：差值 25，floor(25/10)=2。
  const heuristicStored = {
    headers: [
      h("Date", BASE_HTTP),
      h("Last-Modified", "Sun, 31 Dec 2023 23:59:35 GMT"), // BASE-25
    ],
  };
  const input = lookup(req("GET"), stored(heuristicStored), BASE + 1);

  const on = new CacheDecider("shared", true).decide(input);
  assert.equal(on.decision, "fresh");
  expectNumbers(on, 1, 2, 0, 0);

  // 关闭启发式：寿命 0，年龄 1 -> revalidate；Last-Modified 是有效校验器，保留 revalidate。
  const off = new CacheDecider("shared", false).decide(input);
  assert.equal(off.decision, "revalidate");
  assert.equal(off.reason, "revalidate-stale-without-permission");
  expectNumbers(off, 1, 0, 1, 1);

  // 没有任何校验器时才转为 miss（数字仍按公式给出）。
  const noValidator = new CacheDecider("shared", false).decide(
    lookup(req("GET"), stored({ headers: [h("Date", BASE_HTTP)] }), BASE + 1),
  );
  assert.equal(noValidator.decision, "miss");
  assert.equal(noValidator.reason, "miss-no-validator");
  expectNumbers(noValidator, 1, 0, 1, 1);

  // 差值 20 正好整除：floor(20/10)=2。
  const exact = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", BASE_HTTP),
          h("Last-Modified", "Sun, 31 Dec 2023 23:59:40 GMT"), // BASE-20
        ],
      }),
      BASE + 2,
    ),
  );
  expectNumbers(exact, 2, 2, 0, 0);
  assert.equal(exact.decision, "fresh");

  // Last-Modified 晚于 Date：不满足启发式条件，寿命 0。
  const future = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", BASE_HTTP),
          h("Last-Modified", "Mon, 01 Jan 2024 00:00:05 GMT"), // BASE+5
        ],
      }),
      BASE + 1,
    ),
  );
  expectNumbers(future, 1, 0, 1, 1);
});

test("G. Expires 早于 Date（负数寿命改 0）与正常 Expires", () => {
  // Date=BASE，Expires=BASE-30：原始差 -30，截断为 0。
  const expired = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", BASE_HTTP),
          h("Expires", "Sun, 31 Dec 2023 23:59:30 GMT"), // BASE-30
          h("ETag", '"e"'),
        ],
      }),
      BASE + 1,
    ),
  );
  assert.equal(expired.decision, "revalidate");
  expectNumbers(expired, 1, 0, 1, 1);

  // Expires=BASE+30：寿命 30，年龄 10 -> fresh。
  const fresh = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", BASE_HTTP),
          h("Expires", "Mon, 01 Jan 2024 00:00:30 GMT"), // BASE+30
        ],
      }),
      BASE + 10,
    ),
  );
  assert.equal(fresh.decision, "fresh");
  expectNumbers(fresh, 10, 30, 0, 0);
});

test("H. 错误星期按日期缺失处理", () => {
  // 2024-01-01 实际是 Monday，写成 Sunday -> 解析失败，Date 缺失。
  const wrongWeekday = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", "Sun, 01 Jan 2024 00:00:00 GMT"),
          h("Last-Modified", "Sun, 31 Dec 2023 23:59:35 GMT"),
        ],
      }),
      BASE + 1,
    ),
  );
  // Date 缺失 -> 启发式不成立，寿命 0；apparent=0，年龄=1。
  // Last-Modified 仍是有效校验器，所以保留 revalidate 而不是 miss。
  assert.equal(wrongWeekday.decision, "revalidate");
  expectNumbers(wrongWeekday, 1, 0, 1, 1);

  // 正确星期可解析：启发式寿命 2，年龄 1 -> fresh。
  const rightWeekday = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", "Mon, 01 Jan 2024 00:00:00 GMT"),
          h("Last-Modified", "Sun, 31 Dec 2023 23:59:35 GMT"),
        ],
      }),
      BASE + 1,
    ),
  );
  assert.equal(rightWeekday.decision, "fresh");
  expectNumbers(rightWeekday, 1, 2, 0, 0);
});

test("I. 1900-02-29 非法（1900 非闰年）与 2000-02-29 合法", () => {
  // 1900 不能被 400 整除，不是闰年：Last-Modified 解析失败 -> 无校验器。
  const invalidDate = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", BASE_HTTP),
          h("Last-Modified", "Thu, 29 Feb 1900 00:00:00 GMT"),
        ],
      }),
      BASE + 1,
    ),
  );
  assert.equal(invalidDate.decision, "miss");
  assert.equal(invalidDate.reason, "miss-no-validator");
  expectNumbers(invalidDate, 1, 0, 1, 1);

  // 2000 能被 400 整除，是闰年，Tue, 29 Feb 2000 可解析。
  const leap = new CacheDecider("shared", true).decide(
    lookup(
      req("GET"),
      stored({
        headers: [
          h("Date", BASE_HTTP),
          h("Last-Modified", "Tue, 29 Feb 2000 00:00:00 GMT"),
        ],
      }),
      BASE + 1,
    ),
  );
  // 仅验证可解析后进入启发式（差值很大，寿命>0），结论 fresh。
  assert.equal(leap.decision, "fresh");
  assert.ok(leap.lifetime > 0);
});

test("J. 私有缓存接受 private，共享缓存拒绝", () => {
  const privateHeaders = [cc("private, max-age=100")];
  const input = lookup(req("GET"), stored({ headers: privateHeaders }), BASE + 10);

  const privateVerdict = new CacheDecider("private", false).decide(input);
  assert.equal(privateVerdict.decision, "fresh");
  expectNumbers(privateVerdict, 10, 100, 0, 0);

  // private 带字段列表同样拒绝共享缓存。
  const withList = lookup(
    req("GET"),
    stored({ headers: [cc('private="Set-Cookie", max-age=100')] }),
    BASE + 10,
  );
  const sharedVerdict = new CacheDecider("shared", false).decide(withList);
  assert.equal(sharedVerdict.decision, "miss");
  assert.equal(sharedVerdict.reason, "miss-response-private");
  expectNumbers(sharedVerdict, null, null, null, null);
});

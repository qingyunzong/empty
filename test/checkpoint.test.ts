import test from "node:test";
import assert from "node:assert/strict";
import { SignalSeries, SourceDigestMismatchError } from "../src/signal.js";
import type { Cell } from "../src/types.js";

const stream: Cell[] = [
  { value: 2, weight: 1 },
  { value: 4, weight: 2 },
  null,
  { value: 6, weight: 1 },
  { value: 8, weight: 3 },
  { value: 10, weight: 0 },
];

test("检查点携带未闭合窗口与源摘要", () => {
  const s = new SignalSeries(3, stream.slice(0, 4));
  const payload = JSON.parse(s.checkpoint());
  assert.equal(payload.version, 1);
  // t2 缺测，未闭合窗口成员为最近 3 个有效样本位置 t0,t1,t3
  assert.deepEqual(payload.openWindow, { k: 3, members: [0, 1, 3] });
  assert.equal(typeof payload.digest, "string");
  assert.equal(payload.digest.length, 64);
});

test("暂停后恢复：未闭合窗口与源摘要吻合，续算结果一致", () => {
  const original = new SignalSeries(3, stream.slice(0, 4));
  const cp = original.checkpoint();
  const source = original.snapshot();

  const resumed = SignalSeries.resume(cp, source);
  assert.deepEqual(resumed.openWindow(), original.openWindow());
  assert.equal(resumed.digest(), original.digest());

  // 恢复后继续追加，与原序列持续对比
  for (const cell of stream.slice(4)) {
    original.append(cell);
    resumed.append(cell);
    assert.deepEqual(resumed.windowAverage(), original.windowAverage());
  }
});

test("源摘要不匹配时拒绝恢复", () => {
  const s = new SignalSeries(3, stream.slice(0, 4));
  const cp = s.checkpoint();
  const tampered = s.snapshot();
  tampered[0] = { value: 999, weight: 1 };
  assert.throws(() => SignalSeries.resume(cp, tampered), SourceDigestMismatchError);
});

test("未闭合窗口被篡改时拒绝恢复", () => {
  const s = new SignalSeries(3, stream.slice(0, 4));
  const payload = JSON.parse(s.checkpoint());
  payload.openWindow.members = [0, 0, 0];
  assert.throws(
    () => SignalSeries.resume(JSON.stringify(payload), s.snapshot()),
    /unclosed window/,
  );
});

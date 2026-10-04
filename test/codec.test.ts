import { test } from 'node:test';
import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert/strict';
import {
  compress,
  decompress,
  orderOf,
  serializeOrder,
  InputItem,
  Segment,
} from '../src/codec';

function ev(id: number, key: string, ...bytes: number[]): InputItem {
  return { kind: 'event', id, key, value: Uint8Array.from(bytes) };
}

function bar(id: number): InputItem {
  return { kind: 'barrier', id };
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 确定性 PRNG（mulberry32），保证随机测试可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('同 key 连续事件合并为一段，输出初值、终值与被合并 id', () => {
  const out = compress([ev(1, 'a', 0x01), ev(2, 'a', 0x02), ev(3, 'a', 0x03)]);
  strictEqual(out.length, 1);
  const seg = out[0] as Segment;
  strictEqual(seg.kind, 'segment');
  strictEqual(seg.key, 'a');
  deepStrictEqual(seg.ids, [1, 2, 3]);
  deepStrictEqual(seg.firstValue, Uint8Array.from([0x01]));
  deepStrictEqual(seg.lastValue, Uint8Array.from([0x03]));
});

test('不同 key 的相邻事件不合并', () => {
  const out = compress([ev(1, 'a', 1), ev(2, 'b', 2), ev(3, 'a', 3)]);
  deepStrictEqual(
    out.map((it) => it.kind),
    ['segment', 'segment', 'segment'],
  );
  deepStrictEqual((out[0] as Segment).ids, [1]);
  deepStrictEqual((out[1] as Segment).ids, [2]);
  deepStrictEqual((out[2] as Segment).ids, [3]);
});

test('屏障禁止跨越：同 key 被屏障隔开时分成两段', () => {
  const out = compress([ev(1, 'a', 1), ev(2, 'a', 2), bar(3), ev(4, 'a', 4), ev(5, 'a', 5)]);
  strictEqual(out.length, 3);
  deepStrictEqual((out[0] as Segment).ids, [1, 2]);
  deepStrictEqual(out[1], { kind: 'barrier', id: 3 });
  deepStrictEqual((out[2] as Segment).ids, [4, 5]);
  deepStrictEqual((out[0] as Segment).lastValue, Uint8Array.from([2]));
  deepStrictEqual((out[2] as Segment).firstValue, Uint8Array.from([4]));
});

test('逆压缩还原原事件顺序（含屏障位置）', () => {
  const input: InputItem[] = [
    ev(1, 'x', 1), ev(2, 'x', 2), bar(3), ev(4, 'y', 9),
    ev(5, 'x', 3), ev(6, 'x', 4), bar(7), bar(8), ev(9, 'y', 8),
  ];
  const restored = decompress(compress(input));
  deepStrictEqual(restored, orderOf(input));
});

test('顺序字节序列：编码格式稳定', () => {
  const bytes = serializeOrder([
    { kind: 'event', id: 1, key: 'a' },
    { kind: 'barrier', id: 2 },
  ]);
  // 事件: 45 | id(8B BE) | keyLen(2B BE) | utf8(key)；屏障: 42 | id(8B BE)
  strictEqual(hexOf(bytes), '450000000000000001000161420000000000000002');
});

test('空输入与全屏障输入', () => {
  deepStrictEqual(compress([]), []);
  deepStrictEqual(decompress([]), []);
  deepStrictEqual(serializeOrder([]), new Uint8Array(0));
  const onlyBarriers = [bar(1), bar(2)];
  deepStrictEqual(decompress(compress(onlyBarriers)), orderOf(onlyBarriers));
});

test('非法 id 在序列化时被拒绝', () => {
  throws(() => serializeOrder([{ kind: 'event', id: -1, key: 'a' }]));
  throws(() => serializeOrder([{ kind: 'barrier', id: 1.5 }]));
});

test('随机屏障与同键交错：还原后字节序列一致，且段不跨屏障', () => {
  const rand = mulberry32(0xC0FFEE);
  const keys = ['alpha', 'beta', 'gamma', 'delta'];
  const TRIALS = 500;

  for (let trial = 0; trial < TRIALS; trial++) {
    const len = Math.floor(rand() * 121); // 0..120 条
    const input: InputItem[] = [];
    for (let i = 0; i < len; i++) {
      const id = trial * 1000 + i + 1;
      if (rand() < 0.15) {
        input.push(bar(id));
      } else {
        const key = keys[Math.floor(rand() * keys.length)] as string;
        const valueLen = Math.floor(rand() * 25);
        const value = new Uint8Array(valueLen);
        for (let j = 0; j < valueLen; j++) value[j] = Math.floor(rand() * 256);
        input.push({ kind: 'event', id, key, value });
      }
    }

    const compressed = compress(input);
    const restored = decompress(compressed);

    // 1) 还原后字节序列与原顺序字节序列完全一致
    deepStrictEqual(
      serializeOrder(restored),
      serializeOrder(orderOf(input)),
      `trial ${trial}: 还原字节序列不一致`,
    );

    // 2) 压缩输出中不存在相邻同 key 段（即合并充分、屏障切分正确）
    for (let i = 0; i + 1 < compressed.length; i++) {
      const cur = compressed[i];
      const nxt = compressed[i + 1];
      if (cur && nxt && cur.kind === 'segment' && nxt.kind === 'segment') {
        ok(cur.key !== nxt.key, `trial ${trial}: 相邻同 key 段 ${cur.key}`);
      }
    }

    // 3) 每段的初值/终值与被合并的首/末事件值一致
    const valueById = new Map<number, Uint8Array>();
    for (const item of input) {
      if (item.kind === 'event') valueById.set(item.id, item.value);
    }
    for (const item of compressed) {
      if (item.kind !== 'segment') continue;
      ok(item.ids.length >= 1, `trial ${trial}: 空段`);
      deepStrictEqual(item.firstValue, valueById.get(item.ids[0] as number));
      deepStrictEqual(item.lastValue, valueById.get(item.ids[item.ids.length - 1] as number));
    }
  }
});

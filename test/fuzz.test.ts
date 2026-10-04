import { describe, it } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { AmountDocument, Version } from '../src/editor.js';
import { Token } from '../src/lexer.js';
import { formatCents } from '../src/format.js';
import { MAX_CENTS, parseAmount } from '../src/parser.js';
import { mulberry32, pick, randInt } from './util.js';

/** token 跨解析的稳定身份：字节偏移 + 原文 */
function tokenKey(t: { byteOffset: number; byteLength: number; text: string }): string {
  return `${t.byteOffset}:${t.byteLength}:${t.text}`;
}

/** 版本 -> 每个金额位的来源 token 身份集合 */
function versionDigitMap(v: Version): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const d of v.digits) {
    const keys = v
      .digitSource(d.place)
      .map(tokenKey)
      .sort();
    m.set(d.place, keys);
  }
  return m;
}

/** 完整解析 -> 每个金额位的来源 token 身份集合 */
function fullParseDigitMap(text: string): { cents: number; map: Map<number, string[]> } {
  const r = parseAmount(text);
  ok(r.ok, `完整解析失败: ${JSON.stringify(text)}: ${(r as { error?: string }).error}`);
  const byId = new Map(r.tokens.map((t) => [t.id, t]));
  const map = new Map<number, string[]>();
  for (const d of r.digits) {
    map.set(
      d.place,
      d.tokenIds.map((id) => tokenKey(byId.get(id) as Token)).sort(),
    );
  }
  return { cents: r.cents, map };
}

/** 生成随机段内容；valid 控制是否保证合法 */
function randomSegmentContent(rnd: () => number, role: string, valid: boolean): string {
  if (!valid) {
    return pick(rnd, ['1千2千', '1百2千', 'abc', '1万', '99999', '1.2', '千5', '1十十', '1千2百3十45', '12千']);
  }
  if (role === 'decimals') {
    const n = randInt(rnd, 0, 99);
    return rnd() < 0.5 ? String(n) : String(n).padStart(2, '0');
  }
  const style = rnd();
  if (style < 0.4) return String(randInt(rnd, 0, 9999)); // 纯数字
  if (style < 0.5) return '零' + String(randInt(rnd, 0, 999)); // 零占位
  // 单位形式：递减单位子序列
  const units: string[] = [];
  if (rnd() < 0.7) units.push('千');
  if (rnd() < 0.6) units.push('百');
  if (rnd() < 0.5) units.push('十');
  let s = '';
  for (const u of units) s += String(randInt(rnd, 1, 9)) + u;
  if (rnd() < 0.6) s += String(randInt(rnd, 0, 9));
  if (s === '') s = String(randInt(rnd, 0, 9999));
  // 数值可能超过 9999（如 9千9百9十9=9999 恰好合法；9千9百99 非法），交给实现判定
  return s;
}

describe('随机编辑 vs 完整解析：逐位映射核对', () => {
  it('300 轮随机编辑后，增量结果与完整解析逐位一致，旧快照不变', () => {
    const rnd = mulberry32(998877);
    const initial = formatCents(randInt(rnd, 0, MAX_CENTS));
    const created = AmountDocument.create(initial);
    ok(created.ok);
    const doc = created.doc;

    // 记录每个已发布版本的 (text, cents)，之后每轮都复核旧快照未被篡改
    const published: { text: string; cents: number }[] = [
      { text: doc.currentVersion.text, cents: doc.currentVersion.cents },
    ];

    const roles = ['yi', 'wan', 'ones', 'decimals'] as const;
    for (let round = 0; round < 300; round++) {
      const role = pick(rnd, roles);
      const valid = rnd() < 0.75;
      const content = rnd() < 0.12 ? '' : randomSegmentContent(rnd, role, valid);
      const beforeText = doc.currentVersion.text;
      const beforeCount = doc.versionCount;

      const res = doc.setSegment(role, content);
      if (res.ok) {
        const v = res.version;
        equal(doc.versionCount, beforeCount + 1, '成功编辑必须发布且仅发布一个版本');
        equal(v.index, beforeCount);
        // 与完整解析核对：总分 + 逐位来源映射
        const full = fullParseDigitMap(v.text);
        equal(v.cents, full.cents, `第 ${round} 轮总分不一致: ${v.text}`);
        deepEqual(versionDigitMap(v), full.map, `第 ${round} 轮逐位来源不一致: ${v.text}`);
        published.push({ text: v.text, cents: v.cents });
      } else {
        // 错误编辑不发布：版本数与当前文本不变
        equal(doc.versionCount, beforeCount, `第 ${round} 轮错误编辑不应发布`);
        equal(doc.currentVersion.text, beforeText, `第 ${round} 轮错误编辑不应改变当前文本`);
      }

      // 旧快照照样本复核（每 10 轮全量复核）
      if (round % 10 === 9) {
        equal(doc.versionCount, published.length);
        for (let i = 0; i < published.length; i++) {
          const snap = doc.versionAt(i);
          equal(snap.text, (published[i] as { text: string }).text, `快照 ${i} 文本被篡改`);
          equal(snap.cents, (published[i] as { cents: number }).cents, `快照 ${i} 分值被篡改`);
        }
      }
    }
    ok(doc.versionCount > 50, `有效编辑过少（${doc.versionCount}），模糊测试覆盖不足`);
  });
});

describe('随机串鲁棒性', () => {
  it('2000 个随机串：不抛异常，结果自洽', () => {
    const rnd = mulberry32(112233);
    const alphabet = '0123456789十百千万亿零〇.点ab-.';
    for (let i = 0; i < 2000; i++) {
      const len = randInt(rnd, 0, 12);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[randInt(rnd, 0, alphabet.length - 1)];
      const r = parseAmount(s); // 不得抛异常
      if (r.ok) {
        // 自洽：格式化后再解析，分值一致
        const r2 = parseAmount(formatCents(r.cents));
        ok(r2.ok);
        equal(r2.cents, r.cents);
      } else {
        ok(typeof r.error === 'string' && r.error.length > 0);
        ok(Number.isInteger(r.byteOffset) && r.byteOffset >= 0);
      }
    }
  });
});

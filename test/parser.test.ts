import { describe, it } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { MAX_CENTS, parseAmount } from '../src/parser.js';

function centsOf(s: string): number {
  const r = parseAmount(s);
  if (!r.ok) throw new Error(`期望解析成功: ${JSON.stringify(s)}，实际错误: ${r.error}@${r.byteOffset}`);
  return r.cents;
}

function expectInvalid(s: string): void {
  const r = parseAmount(s);
  ok(!r.ok, `期望拒绝: ${JSON.stringify(s)}，实际解析成功 cents=${(r as { cents?: number }).cents}`);
}

describe('合法串取值', () => {
  const cases: [string, number][] = [
    ['0', 0],
    ['5', 500],
    ['零', 0],
    ['〇', 0],
    ['零5', 500],
    ['5零', 500],
    ['10', 1000],
    ['12', 1200],
    ['123', 12300],
    ['1十', 1000],
    ['1千', 100000],
    ['1千2百3十4', 123400],
    ['3千2百5十6', 325600],
    ['3千12', 312000],
    ['3千123', 312300],
    ['1千零5', 100500],
    ['1千零50', 105000],
    ['1千零2百', 120000],
    ['1千零零5', 100500],
    ['9千9百9十9', 999900],
    ['1万', 1000000],
    ['1万零3', 1000300],
    ['12万', 12000000],
    ['2万3', 2000300],
    ['9999万', 9999000000],
    ['1亿', 10000000000],
    ['1亿3', 10000000300],
    ['1亿零3万', 10003000000],
    ['1亿2千3百万45.67', 12300004567],
    ['1亿1千1百1十1万1千1百1十1.11', 11111111111],
    ['9999亿9999万9999.99', MAX_CENTS],
    ['0.01', 1],
    ['0.1', 10],
    ['0.99', 99],
    ['1.05', 105],
    ['1点5', 150],
    ['0.50', 50],
    ['1万.5', 1000050],
    ['零.5', 50],
  ];
  for (const [s, expected] of cases) {
    it(`${JSON.stringify(s)} -> ${expected}`, () => equal(centsOf(s), expected));
  }
});

describe('非法串穷举', () => {
  const invalid: string[] = [
    '', ' ', 'abc', '1a', '１２３', '-1', '+1', '1,000', '九', '1元',
    '.', '点', '1.', '.5', '1.2.3', '1..2', '1.234', '1.零', '1.5零', '1.5万', '1万2.5亿',
    '万', '亿', '亿万', '1亿万', '1亿亿', '1万万', '1万1亿', '1亿1万1亿', '1万2万', '1亿2亿',
    '十', '百', '千', '千5', '1十十', '1千2千', '1百2千', '1十2百', '3千2百5十6十', '1千2百3百4',
    '零万', '零亿', '10000', '10000万', '12千', '9999亿9999万10000', '1千2百3十45',
  ];
  for (const s of invalid) {
    it(`拒绝 ${JSON.stringify(s)}`, () => expectInvalid(s));
  }
});

describe('段内单位序列穷举（十/百/千 长度 1-3 全排列）', () => {
  const units: [string, number][] = [['十', 10], ['百', 100], ['千', 1000]];
  const seqs: [string, number][][] = [];
  for (const a of units) seqs.push([a]);
  for (const a of units) for (const b of units) seqs.push([a, b]);
  for (const a of units) for (const b of units) for (const c of units) seqs.push([a, b, c]);

  for (const seq of seqs) {
    const s = seq.map(([u]) => '2' + u).join('');
    const strictlyDecreasing = seq.every(([, v], i) => i === 0 || v < (seq[i - 1] as [string, number])[1]);
    const label = seq.map(([u]) => u).join('');
    if (strictlyDecreasing) {
      const expected = seq.reduce((acc, [, v]) => acc + 2 * v, 0) * 100;
      it(`接受 ${label} = ${expected}`, () => equal(centsOf(s), expected));
    } else {
      it(`拒绝 ${label}（重复或逆序）`, () => expectInvalid(s));
    }
  }

  it('单位后裸数字落位：2千2百2十3 = 222300', () => equal(centsOf('2千2百2十3'), 222300));
  it('裸数字落位超出个位：2千2百2十34 拒绝', () => expectInvalid('2千2百2十34'));
});

describe('分段结构穷举（亿/万/个/小数 全组合）', () => {
  const yiParts = ['', '1亿'];
  const wanParts = ['', '2万'];
  const onesParts = ['', '3'];
  const decParts: [string, number][] = [['', 0], ['.4', 40], ['.45', 45]];
  for (const yi of yiParts) {
    for (const wan of wanParts) {
      for (const ones of onesParts) {
        for (const [decText, decCents] of decParts) {
          const s = yi + wan + ones + decText;
          const valid = yi !== '' || wan !== '' || ones !== '';
          it(`${JSON.stringify(s)} ${valid ? '接受' : '拒绝'}`, () => {
            if (!valid) {
              expectInvalid(s);
            } else {
              const expected =
                (yi ? 10000000000 : 0) + (wan ? 2000000 : 0) + (ones ? 300 : 0) + decCents;
              equal(centsOf(s), expected);
            }
          });
        }
      }
    }
  }
});

describe('小数形式穷举', () => {
  const valid: [string, number][] = [
    ['1.0', 100], ['1.00', 100], ['1.01', 101], ['1.09', 109], ['1.1', 110],
    ['1.10', 110], ['1.5', 150], ['1.55', 155], ['1.99', 199], ['1点5', 150], ['1点05', 105],
  ];
  for (const [s, expected] of valid) {
    it(`${JSON.stringify(s)} -> ${expected}`, () => equal(centsOf(s), expected));
  }
  const invalid = ['1.', '1..', '1.000', '1.5.', '1.零', '1.5零', '1点', '1点点5', '1.5点'];
  for (const s of invalid) {
    it(`拒绝 ${JSON.stringify(s)}`, () => expectInvalid(s));
  }
});

describe('每位来源（provenance）', () => {
  it('12.34 逐位来源', () => {
    const r = parseAmount('12.34');
    ok(r.ok);
    equal(r.cents, 1234);
    const idByText = new Map(r.tokens.map((t) => [t.text, t.id]));
    const expectSources = (place: number, digit: number, texts: string[]): void => {
      const d = r.digits.find((x) => x.place === place);
      ok(d, `缺少数位 ${place}`);
      equal(d.digit, digit);
      deepEqual([...d.tokenIds].sort((a, b) => a - b), texts.map((t) => idByText.get(t)).sort((a, b) => (a as number) - (b as number)));
    };
    expectSources(1, 4, ['4']);
    expectSources(10, 3, ['3', '4']);
    expectSources(100, 2, ['2', '3', '4']);
    expectSources(1000, 1, ['1', '2', '3', '4']);
  });

  it('零占位不出现在任何位的来源中，且不改变量级', () => {
    const r = parseAmount('1千零5');
    ok(r.ok);
    equal(r.cents, 100500);
    const zeroToken = r.tokens.find((t) => t.kind === 'zero');
    ok(zeroToken);
    for (const d of r.digits) {
      ok(!d.tokenIds.includes(zeroToken.id), `数位 ${d.place} 的来源不应包含零`);
    }
    const one = r.tokens.find((t) => t.text === '1');
    const five = r.tokens.find((t) => t.text === '5');
    const at100 = r.digits.find((d) => d.place === 100);
    const at100000 = r.digits.find((d) => d.place === 100000);
    deepEqual(at100?.tokenIds, [five?.id]);
    deepEqual([...(at100000?.tokenIds ?? [])].sort((a, b) => a - b), [one?.id, five?.id].sort((a, b) => (a as number) - (b as number)));
  });

  it('单位与分隔符 token 不决定任何位', () => {
    const r = parseAmount('1亿2千3百万45.67');
    ok(r.ok);
    equal(r.cents, 12300004567);
    const structural = r.tokens.filter((t) => t.kind !== 'digit').map((t) => t.id);
    for (const d of r.digits) {
      for (const id of structural) ok(!d.tokenIds.includes(id));
    }
  });
});

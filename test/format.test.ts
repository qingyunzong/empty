import { describe, it } from 'node:test';
import { equal, ok, throws } from 'node:assert/strict';
import { formatCents } from '../src/format.js';
import { MAX_CENTS, parseAmount } from '../src/parser.js';
import { mulberry32, randInt } from './util.js';

describe('格式化取值', () => {
  const cases: [number, string][] = [
    [0, '0'],
    [1, '0.01'],
    [10, '0.1'],
    [50, '0.5'],
    [99, '0.99'],
    [100, '1'],
    [105, '1.05'],
    [100500, '1005'],
    [1000300, '1万零3'],
    [1500000, '1万5000'],
    [10000000000, '1亿'],
    [10003000000, '1亿零3万'],
    [10000300000, '1亿零3000'],
    [10000003000, '1亿零30'],
    [10000000300, '1亿零3'],
    [12300004567, '1亿2300万零45.67'],
    [11111111111, '1亿1111万1111.11'],
    [99999999999999, '9999亿9999万9999.99'],
    [MAX_CENTS, '9999亿9999万9999.99'],
  ];
  for (const [cents, expected] of cases) {
    it(`formatCents(${cents}) === ${JSON.stringify(expected)}`, () => {
      equal(formatCents(cents), expected);
    });
  }
});

describe('格式化入参边界', () => {
  it('拒绝越界与非整数', () => {
    throws(() => formatCents(-1));
    throws(() => formatCents(MAX_CENTS + 1));
    throws(() => formatCents(1.5));
    throws(() => formatCents(NaN));
    throws(() => formatCents(Infinity));
  });
  it('边界 0 与 MAX_CENTS 可用', () => {
    equal(formatCents(0), '0');
    equal(formatCents(MAX_CENTS), '9999亿9999万9999.99');
  });
});

describe('逆函数性质：parse ∘ format === 恒等', () => {
  const boundaries = [
    0, 1, 9, 10, 11, 99, 100, 101, 110, 999, 1000, 9999, 10000,
    999900, 1000000, 1000099, 99999900, 100000000, 100030000,
    9999999999, 10000000000, 10000000001, 10003000000, 10000300000,
    99999999999999, 99999999999900, 12345678901234,
  ];
  for (const c of boundaries) {
    it(`roundtrip ${c}`, () => {
      const s = formatCents(c);
      const r = parseAmount(s);
      ok(r.ok, `format(${c})=${JSON.stringify(s)} 无法解析: ${(r as { error?: string }).error}`);
      equal(r.cents, c);
    });
  }

  it('随机值 roundtrip（2000 例）', () => {
    const rnd = mulberry32(20261005);
    for (let i = 0; i < 2000; i++) {
      const c = randInt(rnd, 0, MAX_CENTS);
      const r = parseAmount(formatCents(c));
      ok(r.ok);
      equal(r.cents, c);
    }
  });

  it('format 幂等：format(parse(format(c))) === format(c)', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const c = randInt(rnd, 0, MAX_CENTS);
      const s = formatCents(c);
      const r = parseAmount(s);
      ok(r.ok);
      equal(formatCents(r.cents), s);
    }
  });

  it('规范串是 format 的不动点', () => {
    const canonical = ['0', '0.01', '0.5', '1', '1.05', '1005', '1万零3', '1万5000',
      '1亿', '1亿零3万', '1亿零3000', '1亿零30', '1亿零3', '9999亿9999万9999.99'];
    for (const s of canonical) {
      const r = parseAmount(s);
      ok(r.ok, s);
      equal(formatCents(r.cents), s);
    }
  });
});

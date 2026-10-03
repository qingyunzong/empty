import test from 'node:test';
import assert from 'node:assert/strict';
import { compileScript } from '../src/index.js';

const HEADER = `
customer C1001;
bucket loan limit 1000000;
`;

test('静态类型: 禁止把冻结额当可用额 (E_TYPE)', () => {
  const cases = [
    'guard freeze when frozen("loan") >= available("loan");',
    'guard freeze when available("loan") - frozen("loan") >= 0;',
    'guard freeze when limit("loan") + frozen("loan") >= 0;',
    'guard freeze when frozen("loan") == available("loan");',
  ];
  for (const g of cases) {
    assert.throws(() => compileScript(HEADER + g), (e) => e.code === 'E_TYPE', g);
  }
});

test('静态类型: 同类额度与数字混合合法', () => {
  const ok = `${HEADER}
guard freeze when amount <= 300000;
guard freeze unless frozen("loan") >= 400000;
guard freeze when available("loan") >= amount * 2;
guard freeze when frozen("loan") + frozen("loan") >= 0;
guard freeze when limit("loan") / 2 >= 100;
`;
  assert.doesNotThrow(() => compileScript(ok));
});

test('静态类型: cap 只接受 limit 类型或数字 (E_TYPE)', () => {
  assert.throws(
    () => compileScript(`${HEADER}scope s { cap loan available("loan"); }`),
    (e) => e.code === 'E_TYPE',
  );
  assert.throws(
    () => compileScript(`${HEADER}scope s { cap loan frozen("loan"); }`),
    (e) => e.code === 'E_TYPE',
  );
  assert.doesNotThrow(() => compileScript(`${HEADER}scope s { cap loan limit("loan") / 2; }`));
});

test('guard 子句必须是 bool (E_TYPE)', () => {
  assert.throws(
    () => compileScript(`${HEADER}guard freeze when amount;`),
    (e) => e.code === 'E_TYPE',
  );
});

test('Pratt 优先级: when/unless 与算术比较', () => {
  const src = `${HEADER}
let x = 1 + 2 * 3;
guard freeze when amount + 100 <= 200 * 2 and not amount <= 50 or amount == 1000;
`;
  const ops = compileScript(src);
  assert.ok(Array.isArray(ops));
});

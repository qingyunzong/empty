import test from 'node:test';
import assert from 'node:assert/strict';
import { compileScript, runAll } from '../src/index.js';

const HEADER = `
customer C1001;
note_whitelist /^REQ-[0-9]+$/;
bucket loan limit 1000000;
`;

test('三层审批嵌套: 内层更严上限合法', () => {
  const src = `${HEADER}
scope branch {
  cap loan 800000;
  scope region {
    cap loan 500000;
    scope manager {
      cap loan 400000;
    }
  }
}`;
  assert.doesNotThrow(() => compileScript(src));
});

test('三层审批嵌套: 内层放大上限必失败 (E_SCOPE)', () => {
  const src = `${HEADER}
scope branch {
  cap loan 800000;
  scope region {
    cap loan 500000;
    scope manager {
      cap loan 600000;
    }
  }
}`;
  assert.throws(() => compileScript(src), (e) => e.code === 'E_SCOPE' && /exceeds outer limit 500000/.test(e.message));
});

test('内层 cap 不得超过桶 limit (E_SCOPE)', () => {
  const src = `${HEADER}
scope branch {
  cap loan 1000001;
}`;
  assert.throws(() => compileScript(src), (e) => e.code === 'E_SCOPE');
});

test('shadowing 仅允许只读覆盖: 内层 let 同名合法, set 外层变量非法', () => {
  const ok = `${HEADER}
let max_single = 300000;
scope branch {
  let max_single = 100000;
  guard freeze when amount <= max_single;
}`;
  assert.doesNotThrow(() => compileScript(ok));

  const badSet = `${HEADER}
var max_single = 300000;
scope branch {
  set max_single = 100000;
}`;
  assert.throws(() => compileScript(badSet), (e) => e.code === 'E_SCOPE' && /read-only/.test(e.message));

  const badLet = `${HEADER}
let max_single = 300000;
set max_single = 100000;
`;
  assert.throws(() => compileScript(badLet), (e) => e.code === 'E_SCOPE');
});

test('运行时: 嵌套作用域 cap 逐级强制, 越权冻结返回 E_CAP', () => {
  const src = `${HEADER}
scope branch {
  cap loan 800000;
  scope region {
    cap loan 500000;
    scope manager {
      cap loan 400000;
    }
  }
}`;
  const events = [
    { id: 'a', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 400000, note: 'REQ-1', until: '2026-12-01', scope: 'branch.region.manager' },
    { id: 'b', ts: '2026-10-01T09:01:00Z', type: 'freeze', bucket: 'loan', amount: 1, note: 'REQ-2', until: '2026-12-01', scope: 'branch.region.manager' },
    { id: 'c', ts: '2026-10-01T09:02:00Z', type: 'freeze', bucket: 'loan', amount: 100000, note: 'REQ-3', until: '2026-12-01', scope: 'branch.region' },
    { id: 'd', ts: '2026-10-01T09:03:00Z', type: 'freeze', bucket: 'loan', amount: 1, note: 'REQ-4', until: '2026-12-01', scope: 'branch.region' },
    { id: 'e', ts: '2026-10-01T09:04:00Z', type: 'freeze', bucket: 'loan', amount: 300000, note: 'REQ-5', until: '2026-12-01', scope: 'branch' },
    { id: 'f', ts: '2026-10-01T09:05:00Z', type: 'freeze', bucket: 'loan', amount: 1, note: 'REQ-6', until: '2026-12-01', scope: 'branch' },
    { id: 'g', ts: '2026-10-01T09:06:00Z', type: 'freeze', bucket: 'loan', amount: 1, note: 'REQ-7', until: '2026-12-01', scope: 'no.such.scope' },
  ];
  const { state } = runAll(src, events);
  const byId = Object.fromEntries(state.log.filter((l) => l.seq !== null).map((l) => [l.id, l]));
  assert.equal(byId.a.status, 'ok');
  assert.equal(byId.b.code, 'E_CAP'); // manager 400000 已占满
  assert.equal(byId.c.status, 'ok'); // region 400000+100000 <= 500000
  assert.equal(byId.d.code, 'E_CAP'); // region 500000 已占满
  assert.equal(byId.e.status, 'ok'); // branch 500000+300000 <= 800000
  assert.equal(byId.f.code, 'E_CAP'); // branch 800000 已占满
  assert.equal(byId.g.code, 'E_SCOPE'); // 未知审批作用域
  assert.equal(state.buckets.get('loan').frozen, 800000);
  assert.equal(state.buckets.get('loan').available, 200000);
});

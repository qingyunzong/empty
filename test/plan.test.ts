import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synchronize } from '../src/index.js';
import { applyPlan, buildPlan, verifyPlan } from '../src/plan.js';
import { FileEntry, Snapshot } from '../src/model.js';

const file = (id: string, path: string, fields: Record<string, string>, version = 1): FileEntry => ({
  id,
  path,
  fields,
  version,
});
const snap = (...files: FileEntry[]): Snapshot => Object.fromEntries(files.map((f) => [f.id, f]));

test('存在未解决冲突时不产出计划', () => {
  const base = snap(file('a', '/a.md', { title: 'T' }));
  const local = snap(file('a', '/a.md', { title: 'L' }, 2));
  const remote = snap(file('a', '/a.md', { title: 'R' }, 2));
  const out = synchronize({ base, local, remote });
  assert.equal(out.plan, null);
  assert.equal(out.merge.conflicts.length, 1);
});

test('计划应用到 base 精确复现合并结果（含增删改）', () => {
  const base = snap(
    file('keep', '/keep.md', { title: 'K' }),
    file('mod', '/mod.md', { title: 'M', body: 'B' }),
    file('del', '/del.md', { title: 'D' }),
  );
  const local = snap(
    file('keep', '/keep.md', { title: 'K' }),
    file('mod', '/mod.md', { title: 'M2', body: 'B' }, 2),
    file('new', '/new.md', { title: 'N' }),
  );
  const remote = snap(
    file('keep', '/keep.md', { title: 'K' }),
    file('mod', '/mod.md', { title: 'M', body: 'B2' }, 2),
    file('new', '/new.md', { title: 'N' }),
  );
  const out = synchronize({ base, local, remote });
  assert.notEqual(out.plan, null);
  const applied = applyPlan(base, out.plan!);
  assert.deepEqual(applied, out.merge.state);
  assert.deepEqual(applied['mod']!.fields, { title: 'M2', body: 'B2' });
  assert.equal(applied['del'], undefined);
  assert.equal(applied['new']!.path, '/new.md');
});

test('交换路径：计划经临时移动保持全程路径唯一', () => {
  const base = snap(file('a', '/a.md', { title: 'A' }), file('b', '/b.md', { title: 'B' }));
  const local = snap(file('a', '/b.md', { title: 'A' }, 2), file('b', '/a.md', { title: 'B' }, 2));
  const remote = snap(file('a', '/b.md', { title: 'A' }, 2), file('b', '/a.md', { title: 'B' }, 2));
  const out = synchronize({ base, local, remote });
  assert.equal(out.merge.conflicts.length, 0);
  const ops = out.plan!.ops;
  assert.ok(ops.some((o) => o.op === 'move' && o.path.startsWith('.__sync_tmp__/')));
  const applied = applyPlan(base, out.plan!); // 每步校验路径唯一，冲突会抛错
  assert.equal(applied['a']!.path, '/b.md');
  assert.equal(applied['b']!.path, '/a.md');
  verifyPlan(base, out.merge.state, out.plan!);
});

test('原子性：被篡改的计划在校验阶段整体失败', () => {
  const base = snap(file('a', '/a.md', { title: 'A' }), file('b', '/b.md', { title: 'B' }));
  const merged = {
    a: { id: 'a', path: '/a.md', fields: { title: 'A2' } },
    b: { id: 'b', path: '/b.md', fields: { title: 'B' } },
  };
  const plan = buildPlan(base, merged);
  plan.ops.push({ op: 'create', id: 'evil', path: '/b.md', fields: {} }); // 占用已有路径
  assert.throws(() => applyPlan(base, plan), /路径冲突/);
  assert.throws(() => verifyPlan(base, merged, plan));
});

test('计划与合并结果不一致时 verifyPlan 抛错', () => {
  const base = snap(file('a', '/a.md', { title: 'A' }));
  const merged = { a: { id: 'a', path: '/a.md', fields: { title: 'A2' } } };
  const plan = buildPlan(base, merged);
  const wrong = { a: { id: 'a', path: '/a.md', fields: { title: 'A3' } } };
  assert.throws(() => verifyPlan(base, wrong, plan), /不一致/);
});

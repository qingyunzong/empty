import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Conflict, merge, Resolution, ResolutionChoice } from '../src/merge.js';
import { FileEntry, Snapshot } from '../src/model.js';

const file = (id: string, path: string, fields: Record<string, string>, version = 1): FileEntry => ({
  id,
  path,
  fields,
  version,
});
const snap = (...files: FileEntry[]): Snapshot => Object.fromEntries(files.map((f) => [f.id, f]));
const resolve = (c: Conflict, choice: ResolutionChoice): Resolution => ({
  conflictId: c.id,
  fingerprint: c.fingerprint,
  choice,
});

test('不同字段的修改自动合并', () => {
  const base = snap(file('a', '/doc/a.md', { title: 'T', body: 'B' }));
  const local = snap(file('a', '/doc/a.md', { title: 'T2', body: 'B' }, 2));
  const remote = snap(file('a', '/doc/a.md', { title: 'T', body: 'B2' }, 2));
  const r = merge({ base, local, remote });
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(r.state['a'], { id: 'a', path: '/doc/a.md', fields: { title: 'T2', body: 'B2' } });
});

test('同一字段双侧修改 -> 字段冲突，可按侧解决', () => {
  const base = snap(file('a', '/a.md', { title: 'T' }));
  const local = snap(file('a', '/a.md', { title: 'L' }, 2));
  const remote = snap(file('a', '/a.md', { title: 'R' }, 2));
  const r1 = merge({ base, local, remote });
  assert.equal(r1.conflicts.length, 1);
  assert.equal(r1.conflicts[0]!.kind, 'field');
  assert.equal(r1.conflicts[0]!.id, 'field:a:title');

  const r2 = merge({ base, local, remote, resolutions: [resolve(r1.conflicts[0]!, { side: 'remote' })] });
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.state['a']!.fields['title'], 'R');
  assert.equal(r2.applied.length, 1);
});

test('解决后源版本变化 -> 撤销过时选择，冲突重现', () => {
  const base = snap(file('a', '/a.md', { title: 'T' }));
  const local = snap(file('a', '/a.md', { title: 'L' }, 2));
  const remote = snap(file('a', '/a.md', { title: 'R' }, 2));
  const r1 = merge({ base, local, remote });
  const res = resolve(r1.conflicts[0]!, { side: 'local' });

  // remote 源版本推进（版本号与内容均变化）
  const remote2 = snap(file('a', '/a.md', { title: 'R2' }, 3));
  const r2 = merge({ base, local, remote: remote2, resolutions: [res] });
  assert.equal(r2.conflicts.length, 1);
  assert.equal(r2.applied.length, 0);
  assert.equal(r2.stale.length, 1);
  assert.equal(r2.stale[0]!.conflictId, 'field:a:title');
});

test('一侧删除、另一侧未修改 -> 删除，无冲突', () => {
  const base = snap(file('a', '/a.md', { title: 'T' }));
  const local = snap();
  const remote = snap(file('a', '/a.md', { title: 'T' }));
  const r = merge({ base, local, remote });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.state['a'], undefined);
});

test('删除对修改 -> delete-modify 冲突，可分别按 delete/keep 解决', () => {
  const base = snap(file('a', '/a.md', { title: 'T' }));
  const local = snap();
  const remote = snap(file('a', '/a.md', { title: 'T2' }, 2));
  const r1 = merge({ base, local, remote });
  assert.equal(r1.conflicts.length, 1);
  assert.equal(r1.conflicts[0]!.kind, 'delete-modify');

  const keep = merge({ base, local, remote, resolutions: [resolve(r1.conflicts[0]!, { action: 'keep' })] });
  assert.equal(keep.conflicts.length, 0);
  assert.equal(keep.state['a']!.fields['title'], 'T2');

  const del = merge({ base, local, remote, resolutions: [resolve(r1.conflicts[0]!, { action: 'delete' })] });
  assert.equal(del.conflicts.length, 0);
  assert.equal(del.state['a'], undefined);
});

test('字段级删除对修改 -> 字段冲突', () => {
  const base = snap(file('a', '/a.md', { title: 'T', tag: 'x' }));
  const local = snap(file('a', '/a.md', { title: 'T' }, 2)); // 删除 tag
  const remote = snap(file('a', '/a.md', { title: 'T', tag: 'y' }, 2)); // 修改 tag
  const r = merge({ base, local, remote });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.id, 'field:a:tag');
});

test('双侧改名到不同路径 -> rename 冲突；改到同一路径 -> 自动合并', () => {
  const base = snap(file('a', '/old.md', { title: 'T' }));
  const local = snap(file('a', '/local.md', { title: 'T' }, 2));
  const remote = snap(file('a', '/remote.md', { title: 'T' }, 2));
  const r1 = merge({ base, local, remote });
  assert.equal(r1.conflicts.length, 1);
  assert.equal(r1.conflicts[0]!.kind, 'rename');
  const r2 = merge({ base, local, remote, resolutions: [resolve(r1.conflicts[0]!, { side: 'local' })] });
  assert.equal(r2.state['a']!.path, '/local.md');

  const sameLocal = snap(file('a', '/same.md', { title: 'T' }, 2));
  const sameRemote = snap(file('a', '/same.md', { title: 'T' }, 2));
  const r3 = merge({ base, local: sameLocal, remote: sameRemote });
  assert.equal(r3.conflicts.length, 0);
  assert.equal(r3.state['a']!.path, '/same.md');
});

test('不同文件占用同一目标路径 -> path-occupation 冲突，显式分配路径解决', () => {
  const base = snap(file('a', '/a.md', { title: 'A' }), file('b', '/b.md', { title: 'B' }));
  const local = snap(file('a', '/shared.md', { title: 'A' }, 2), file('b', '/b.md', { title: 'B' }));
  const remote = snap(file('a', '/a.md', { title: 'A' }), file('b', '/shared.md', { title: 'B' }, 2));
  const r1 = merge({ base, local, remote });
  assert.equal(r1.conflicts.length, 1);
  assert.equal(r1.conflicts[0]!.kind, 'path-occupation');
  assert.deepEqual(r1.conflicts[0]!.fileIds, ['a', 'b']);

  const r2 = merge({
    base,
    local,
    remote,
    resolutions: [resolve(r1.conflicts[0]!, { paths: { a: '/shared.md', b: '/b-renamed.md' } })],
  });
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.state['a']!.path, '/shared.md');
  assert.equal(r2.state['b']!.path, '/b-renamed.md');
});

test('路径占用解决方案仍冲突 -> 冲突保持未解决', () => {
  const base = snap(file('a', '/a.md', { title: 'A' }), file('b', '/b.md', { title: 'B' }));
  const local = snap(file('a', '/shared.md', { title: 'A' }, 2), file('b', '/b.md', { title: 'B' }));
  const remote = snap(file('a', '/a.md', { title: 'A' }), file('b', '/shared.md', { title: 'B' }, 2));
  const r1 = merge({ base, local, remote });
  const r2 = merge({
    base,
    local,
    remote,
    resolutions: [resolve(r1.conflicts[0]!, { paths: { a: '/shared.md', b: '/shared.md' } })],
  });
  assert.equal(r2.conflicts.length, 1);
  assert.equal(r2.conflicts[0]!.kind, 'path-occupation');
});

test('一侧删除释放路径，另一侧改名占用 -> 无冲突', () => {
  const base = snap(file('a', '/a.md', { title: 'A' }), file('b', '/b.md', { title: 'B' }));
  const local = snap(file('a', '/a.md', { title: 'A' })); // 删除 b
  const remote = snap(file('a', '/b.md', { title: 'A' }, 2), file('b', '/b.md', { title: 'B' }));
  const r = merge({ base, local, remote });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.state['a']!.path, '/b.md');
  assert.equal(r.state['b'], undefined);
});

test('单侧新增与双侧同内容新增 -> 无冲突', () => {
  const base = snap();
  const oneSide = merge({ base, local: snap(file('n', '/n.md', { title: 'N' })), remote: snap() });
  assert.equal(oneSide.conflicts.length, 0);
  assert.equal(oneSide.state['n']!.path, '/n.md');

  const both = merge({
    base,
    local: snap(file('n', '/n.md', { title: 'N' })),
    remote: snap(file('n', '/n.md', { title: 'N' })),
  });
  assert.equal(both.conflicts.length, 0);
});

test('双侧新增同 id 不同字段 -> 按空 base 逐字段合并/冲突', () => {
  const base = snap();
  const local = snap(file('n', '/n.md', { title: 'L', body: 'B' }));
  const remote = snap(file('n', '/n.md', { title: 'R', body: 'B' }));
  const r = merge({ base, local, remote });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.id, 'field:n:title');
  assert.equal(r.state['n']!.fields['body'], 'B');
});

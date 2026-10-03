import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solve } from '../src/solver.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));

test('高技能任务无人具备：返回不可行冲突证明', () => {
  const res = solve(load('infeasible.json'), { budget: 1000 });
  assert.equal(res.status, 'infeasible');
  assert.equal(res.conflict.type, 'skill');
  assert.deepEqual(res.conflict.tasks, ['t-hard']);
  assert.deepEqual(res.conflict.missingSkills, ['high-voltage']);
  assert.ok(Array.isArray(res.conflict.persons));
  assert.ok(res.conflict.persons.every((p) => !p.skills.includes('high-voltage')));
});

test('单人两任务窗口互斥：返回序列/窗口冲突证明', () => {
  const input = {
    skills: ['electrical'],
    inspectors: [{ id: 'p1', skills: ['electrical'] }],
    tasks: [
      { id: 'a', zone: 'A', skills: ['electrical'], duration: 6, window: [0, 5] },
      { id: 'b', zone: 'A', skills: ['electrical'], duration: 6, window: [0, 5] },
    ],
  };
  const res = solve(input, { budget: 1000 });
  assert.equal(res.status, 'infeasible');
  assert.ok(['sequence', 'window'].includes(res.conflict.type));
  assert.ok(res.conflict.tasks.length >= 1);
});

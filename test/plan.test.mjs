import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlan, PlanError } from '../src/plan.js';

function expectInvalid(plan, pattern) {
  assert.throws(() => normalizePlan(plan), (error) => {
    assert.ok(error instanceof PlanError);
    assert.ok(
      error.details.some((detail) => pattern.test(detail)),
      `expected a detail matching ${pattern}, got: ${error.details.join('; ')}`,
    );
    return true;
  });
}

const validPlan = {
  accounts: [
    { id: 'A', balance: 100 },
    { id: 'B', balance: 0 },
  ],
  actors: [
    {
      id: 'alice',
      steps: [
        { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 40 },
        { id: 'c1', type: 'commit', transfer: 't1' },
      ],
    },
  ],
  freeze: [{ id: 'f1', account: 'A' }],
};

test('valid plan normalizes and freeze plan becomes an ordered actor', () => {
  const plan = normalizePlan(validPlan);
  assert.equal(plan.initialTotal, 100);
  assert.equal(plan.actors.length, 2);
  const freezeActor = plan.actors.find((actor) => actor.id === 'freeze');
  assert.deepEqual(freezeActor.steps, [{ id: 'f1', type: 'freeze', account: 'A' }]);
});

test('unknown transfer id is rejected', () => {
  expectInvalid(
    {
      accounts: [{ id: 'A', balance: 10 }],
      actors: [{ id: 'a', steps: [{ id: 'c1', type: 'commit', transfer: 'nope' }] }],
    },
    /unknown transfer id/,
  );
});

test('unknown account id is rejected', () => {
  expectInvalid(
    {
      accounts: [{ id: 'A', balance: 10 }],
      actors: [
        { id: 'a', steps: [{ id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'Z', amount: 1 }] },
      ],
    },
    /unknown account id/,
  );
});

test('duplicate step id is rejected', () => {
  expectInvalid(
    {
      accounts: [
        { id: 'A', balance: 10 },
        { id: 'B', balance: 0 },
      ],
      actors: [
        {
          id: 'a',
          steps: [
            { id: 's1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 1 },
            { id: 's1', type: 'commit', transfer: 't1' },
          ],
        },
      ],
    },
    /duplicate step id: s1/,
  );
});

test('duplicate transfer id is rejected', () => {
  expectInvalid(
    {
      accounts: [
        { id: 'A', balance: 10 },
        { id: 'B', balance: 0 },
      ],
      actors: [
        { id: 'a', steps: [{ id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 1 }] },
        { id: 'b', steps: [{ id: 'r2', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 1 }] },
      ],
    },
    /duplicate transfer id: t1/,
  );
});

test('negative and non-integer amounts are rejected', () => {
  for (const amount of [-5, 0, 1.5, '10']) {
    expectInvalid(
      {
        accounts: [
          { id: 'A', balance: 10 },
          { id: 'B', balance: 0 },
        ],
        actors: [
          { id: 'a', steps: [{ id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount }] },
        ],
      },
      /amount must be a positive integer/,
    );
  }
});

test('cancel before commit of the same transfer in one actor is rejected', () => {
  expectInvalid(
    {
      accounts: [
        { id: 'A', balance: 10 },
        { id: 'B', balance: 0 },
      ],
      actors: [
        {
          id: 'a',
          steps: [
            { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 1 },
            { id: 'x1', type: 'cancel', transfer: 't1' },
            { id: 'c1', type: 'commit', transfer: 't1' },
          ],
        },
      ],
    },
    /cancel of transfer t1 before its commit/,
  );
});

test('commit before reserve of the same transfer in one actor is rejected', () => {
  expectInvalid(
    {
      accounts: [
        { id: 'A', balance: 10 },
        { id: 'B', balance: 0 },
      ],
      actors: [
        {
          id: 'a',
          steps: [
            { id: 'c1', type: 'commit', transfer: 't1' },
            { id: 'r1', type: 'reserve', transfer: 't1', from: 'A', to: 'B', amount: 1 },
          ],
        },
      ],
    },
    /commit of transfer t1 before its reserve/,
  );
});

test('duplicate account id and negative initial balance are rejected', () => {
  expectInvalid(
    {
      accounts: [
        { id: 'A', balance: 10 },
        { id: 'A', balance: 5 },
      ],
      actors: [],
    },
    /duplicate account id/,
  );
  expectInvalid(
    {
      accounts: [{ id: 'A', balance: -1 }],
      actors: [],
    },
    /balance must be a non-negative integer/,
  );
});

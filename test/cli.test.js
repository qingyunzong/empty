import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execute } from '../cli.js'

const CLI = new URL('../cli.js', import.meta.url).pathname

const oneOrder = {
  calendar: {
    start: '2026-01-05T00:00:00Z',
    days: 1,
    shifts: [{ days: [1], start: '08:00', end: '16:00' }],
  },
  machines: [{ id: 'M1' }],
  orders: [{ id: 'O1', product: 'P1', quantity: 2, route: [{ machines: ['M1'], cycle: 30 }] }],
}

test('CLI core prints plan JSON for a valid input', () => {
  const { status, output } = execute(oneOrder)
  assert.equal(status, 0)
  assert.equal(output.ok, true)
  assert.deepEqual(output.plan.orders[0].operations[0], {
    seq: 0, machine: 'M1',
    start: '2026-01-05T08:00:00.000Z', end: '2026-01-05T09:00:00.000Z', duration: 60,
  })
})

test('CLI runs command groups with undo/redo', () => {
  const { status, output } = execute({
    ...oneOrder,
    orders: [{ id: 'O1', product: 'P1', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }],
    commands: [
      {
        type: 'group',
        commands: [
          { type: 'addOrders', orders: [{ id: 'O2', product: 'P2', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }] },
          { type: 'addOrders', orders: [{ id: 'O3', product: 'P3', quantity: 1, route: [{ machines: ['M1'], cycle: 60 }] }] },
        ],
      },
      { type: 'undo' },
    ],
  })
  assert.equal(status, 0)
  assert.equal(output.commandResults[1].changed, true)
  assert.deepEqual(output.plan.orders.map((o) => o.id), ['O1']) // whole group undone
})

test('CLI reports rush budget failure in command results and keeps state', () => {
  const { status, output } = execute({
    calendar: {
      start: '2026-01-05T00:00:00Z',
      days: 1,
      shifts: [{ days: [1], start: '08:00', end: '16:30' }],
      downtimes: [
        { start: '2026-01-05T10:00:00Z', end: '2026-01-05T11:00:00Z' },
        { start: '2026-01-05T12:00:00Z', end: '2026-01-05T13:00:00Z' },
        { start: '2026-01-05T14:00:00Z', end: '2026-01-05T15:00:00Z' },
      ],
    },
    machines: [{ id: 'M1' }],
    orders: [
      { id: 'O1', product: 'P1', quantity: 1, due: '2026-01-05T16:00:00Z', route: [{ machines: ['M1'], cycle: 60 }] },
      { id: 'O2', product: 'P2', quantity: 1, due: '2026-01-05T17:00:00Z', route: [{ machines: ['M1'], cycle: 60 }] },
      { id: 'O3', product: 'P3', quantity: 1, due: '2026-01-05T18:00:00Z', route: [{ machines: ['M1'], cycle: 90 }] },
    ],
    commands: [
      {
        type: 'insertRush',
        order: { id: 'R1', product: 'PR', quantity: 1, route: [{ machines: ['M1'], cycle: 90 }] },
        budget: 1,
      },
    ],
  })
  assert.equal(status, 0)
  const result = output.commandResults[0]
  assert.equal(result.ok, false)
  assert.equal(result.code, 'RESCHEDULE_BUDGET_EXCEEDED')
  assert.equal(result.required, 2)
  assert.equal(result.deficit, 1)
  assert.deepEqual(output.plan.orders.map((o) => o.id), ['O1', 'O2', 'O3']) // unchanged
})

test('CLI exits 1 with explicit CODE for cyclic route', () => {
  const { status, output } = execute({
    ...oneOrder,
    orders: [{
      id: 'O1', product: 'P1', quantity: 1,
      route: { steps: [
        { id: 'a', next: 'b', machines: ['M1'], cycle: 10 },
        { id: 'b', next: 'a', machines: ['M1'], cycle: 10 },
      ] },
    }],
  })
  assert.equal(status, 1)
  assert.equal(output.ok, false)
  assert.equal(output.error.code, 'CYCLIC_ROUTE')
})

test('CLI exits 1 with explicit CODE for calendar overlap and infeasible', () => {
  const overlap = execute({
    calendar: {
      start: '2026-01-05T00:00:00Z',
      days: 1,
      shifts: [{ days: [1], start: '08:00', end: '16:00' }],
      downtimes: [
        { start: '2026-01-05T10:00:00Z', end: '2026-01-05T12:00:00Z' },
        { start: '2026-01-05T11:00:00Z', end: '2026-01-05T13:00:00Z' },
      ],
    },
    machines: [{ id: 'M1' }],
  })
  assert.equal(overlap.status, 1)
  assert.equal(overlap.output.error.code, 'CALENDAR_OVERLAP')

  const infeasible = execute({
    ...oneOrder,
    orders: [{ id: 'O1', product: 'P1', quantity: 1, route: [{ machines: ['M1'], cycle: 9999 }] }],
  })
  assert.equal(infeasible.status, 1)
  assert.equal(infeasible.output.error.code, 'INFEASIBLE')
})

// End-to-end through a real child process: file argument and stdin.
// Skipped when the environment forbids nested process spawning (EPERM).
function spawnCli(args, stdinFile) {
  const redirect = stdinFile ? `< "${stdinFile}"` : ''
  return spawnSync('bash', ['-c', `node "${CLI}" ${args.map((a) => `"${a}"`).join(' ')} ${redirect}`], {
    encoding: 'utf8',
  })
}

test('CLI end-to-end: file argument and stdin', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-'))
  const file = join(dir, 'input.json')
  writeFileSync(file, JSON.stringify(oneOrder))

  const fromFile = spawnCli([file])
  if (fromFile.error?.code === 'EPERM' || (fromFile.status === 0 && !fromFile.stdout)) {
    t.skip('nested process spawning is blocked in this environment')
    return
  }
  assert.equal(fromFile.status, 0, fromFile.stderr)
  const fileOutput = JSON.parse(fromFile.stdout)
  assert.equal(fileOutput.ok, true)
  assert.equal(fileOutput.plan.orders[0].operations[0].duration, 60)

  const fromStdin = spawnCli([], file)
  assert.equal(fromStdin.status, 0, fromStdin.stderr)
  assert.deepEqual(JSON.parse(fromStdin.stdout), fileOutput)

  const bad = join(dir, 'bad.json')
  writeFileSync(bad, JSON.stringify({
    ...oneOrder,
    orders: [{ id: 'O1', product: 'P1', quantity: 1, route: [{ machines: ['M1'], cycle: 9999 }] }],
  }))
  const failed = spawnCli([bad])
  assert.equal(failed.status, 1)
  assert.equal(JSON.parse(failed.stdout).error.code, 'INFEASIBLE')
})

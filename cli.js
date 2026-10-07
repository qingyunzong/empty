#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Planner } from './src/planner.js'
import { PlanError } from './src/errors.js'

function runCommand(planner, cmd) {
  if (!cmd || typeof cmd !== 'object') {
    throw new PlanError('VALIDATION', 'command must be an object')
  }
  switch (cmd.type) {
    case 'addOrders':
      return { type: cmd.type, ...planner.addOrders(cmd.orders ?? []) }
    case 'insertRush':
      return { type: cmd.type, ...planner.insertRush(cmd.order, cmd.budget ?? 0) }
    case 'undo':
      return { type: cmd.type, ...planner.undo() }
    case 'redo':
      return { type: cmd.type, ...planner.redo() }
    case 'group':
      return {
        type: cmd.type,
        results: planner.group(() => (cmd.commands ?? []).map((c) => runCommand(planner, c))),
      }
    default:
      throw new PlanError('VALIDATION', `unknown command type: ${cmd.type}`)
  }
}

// Pure core: input object -> { status, output }. Importable for tests.
export function execute(input) {
  try {
    const planner = new Planner(input)
    const commandResults = []
    for (const cmd of input.commands ?? []) {
      commandResults.push(runCommand(planner, cmd))
    }
    return { status: 0, output: { ok: true, plan: planner.toJSON(), commandResults } }
  } catch (err) {
    if (err instanceof PlanError) {
      const error = { code: err.code, message: err.message }
      if (err.details !== undefined) error.details = err.details
      return { status: 1, output: { ok: false, error } }
    }
    throw err
  }
}

function main() {
  const arg = process.argv[2]
  const text = arg ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8')
  let input
  try {
    input = JSON.parse(text)
  } catch {
    process.stderr.write('error: input is not valid JSON\n')
    process.exit(2)
  }
  try {
    const { status, output } = execute(input)
    process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    process.exit(status)
  } catch (err) {
    process.stderr.write(String(err?.stack ?? err) + '\n')
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}

'use strict';
const fs = require('node:fs');
const { Engine } = require('./engine');

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'input must be a JSON object';
  }
  if (!Array.isArray(input.instructions) || input.instructions.length === 0) {
    return 'input.instructions must be a non-empty array';
  }
  for (const instruction of input.instructions) {
    if (!instruction || typeof instruction.id !== 'string') {
      return 'every instruction needs a string id';
    }
    if (instruction.side !== 'buy' && instruction.side !== 'sell') {
      return `instruction ${instruction.id}: side must be "buy" or "sell"`;
    }
    if (typeof instruction.security !== 'string' || !instruction.security) {
      return `instruction ${instruction.id}: security must be a non-empty string`;
    }
    if (!Number.isFinite(instruction.price) || instruction.price <= 0) {
      return `instruction ${instruction.id}: price must be a positive number`;
    }
    if (!Number.isInteger(instruction.quantity) || instruction.quantity <= 0) {
      return `instruction ${instruction.id}: quantity must be a positive integer`;
    }
  }
  const sides = new Set(input.instructions.map((i) => i.side));
  if (!sides.has('buy') || !sides.has('sell')) {
    return 'single-sided instructions: both buy and sell instructions are required';
  }
  if (input.accounts !== undefined && !Array.isArray(input.accounts)) {
    return 'input.accounts must be an array';
  }
  for (const account of input.accounts || []) {
    if (!account || typeof account.id !== 'string') return 'every account needs a string id';
  }
  if (input.cancellations !== undefined && !Array.isArray(input.cancellations)) {
    return 'input.cancellations must be an array';
  }
  if (input.permissions !== undefined && !Array.isArray(input.permissions)) {
    return 'input.permissions must be an array of [buyId, sellId] pairs';
  }
  return null;
}

function main(argv) {
  const [command, inputPath, outputPath] = argv;
  if (command !== 'deliver' || !inputPath || !outputPath) {
    console.error('usage: node . deliver input.json output.json');
    return 1;
  }
  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (error) {
    console.error(`error: cannot read ${inputPath}: ${error.message}`);
    return 1;
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    console.error(`error: invalid JSON in ${inputPath}: ${error.message}`);
    return 1;
  }
  const problem = validate(input);
  if (problem) {
    console.error(`error: ${problem}`);
    return 1;
  }
  const walPath = input.walPath || `${outputPath}.wal`;
  const engine = new Engine(walPath);
  engine.recover();
  const result = engine.deliver(input);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
  return 0;
}

module.exports = { main, validate };

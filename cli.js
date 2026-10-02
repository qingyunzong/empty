#!/usr/bin/env node
// 用法: node cli.js <plan.json>
// 输出: SAT -> { status, downtime, plans:[{actions, downtime, budgetRemaining}] }
//       UNSAT -> { status, certificate }（最小不可行证书，可用 verifyCertificate 复验）
// 退出码: 0 = 正常求解（含 UNSAT）；1 = 域错误（ERR_DOMAIN）；2 = 参数错误。

import { readFileSync } from 'node:fs';
import { Planner } from './src/planner.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node cli.js <plan.json>');
  process.exit(2);
}

let problem;
try {
  problem = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(JSON.stringify({ error: { code: 'ERR_IO', message: err.message } }));
  process.exit(1);
}

try {
  const planner = new Planner(problem);
  const result = planner.solve();
  if (result.status === 'SAT') {
    console.log(JSON.stringify({
      status: 'SAT',
      downtime: result.downtime,
      plans: result.plans.map((plan) => ({
        actions: plan.actions,
        downtime: plan.downtime,
        budgetRemaining: plan.budgetRemaining,
      })),
    }, null, 2));
  } else {
    console.log(JSON.stringify({ status: 'UNSAT', certificate: result.certificate }, null, 2));
  }
} catch (err) {
  if (err.code === 'ERR_DOMAIN') {
    console.error(JSON.stringify({ error: { code: 'ERR_DOMAIN', message: err.message } }));
    process.exit(1);
  }
  throw err;
}

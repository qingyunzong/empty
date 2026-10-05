// 投放规划 CLI：solve / verify / sample / brute 四个子命令，仅使用 Node 内置库。
import { readFileSync, writeFileSync } from 'node:fs';
import { validateInput, type PlanInput } from './model.js';
import { solve } from './solve.js';
import { bruteForce, canBruteForce, bruteForceCombinations, solutionsAgree } from './brute.js';
import { buildCertificate, verifyCertificate, type BudgetCertificate } from './certificate.js';
import { generateSample } from './sample.js';

const USAGE = `投放规划 CLI（整数投放量 0-10，至多 16 广告组，分渠道预算 + 总曝光下限）

用法：
  node src/cli.ts solve <config.json> [--cert <out.json>] [--json]
  node src/cli.ts verify <config.json> <cert.json>
  node src/cli.ts brute <config.json>          小量穷举对照（11^n <= 2,000,000）
  node src/cli.ts sample [--out <file.json>]   生成确定性样例配置
`;

function loadInput(path: string): PlanInput {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return validateInput(raw);
}

function cmdSolve(args: string[]): void {
  const configPath = args[0];
  if (!configPath) throw new Error('缺少配置文件路径');
  const jsonMode = args.includes('--json');
  const certIdx = args.indexOf('--cert');
  const certPath = certIdx >= 0 ? args[certIdx + 1] : undefined;

  const input = loadInput(configPath);
  const solution = solve(input);

  // 小量实例自动做穷举对照，结果写入证书。
  let crossCheck: { checked: boolean; combinations?: number; match?: boolean; reason?: string };
  if (canBruteForce(input)) {
    const brute = bruteForce(input);
    crossCheck = {
      checked: true,
      combinations: bruteForceCombinations(input.groups.length),
      match: solutionsAgree(solution, brute),
    };
  } else {
    crossCheck = {
      checked: false,
      reason: `组合数 11^${input.groups.length} = ${bruteForceCombinations(input.groups.length)} 超过穷举上限`,
    };
  }

  const cert = buildCertificate(input, solution, crossCheck);
  if (certPath) writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');

  if (jsonMode) {
    console.log(JSON.stringify(cert, null, 2));
    return;
  }
  printReport(input, solution, cert, certPath);
}

function printReport(
  input: PlanInput,
  solution: ReturnType<typeof solve>,
  cert: BudgetCertificate,
  certPath: string | undefined,
): void {
  const lines: string[] = [];
  lines.push(`状态: ${solution.status === 'optimal' ? '最优解' : '无可行解（曝光下限不可达）'}`);
  if (solution.status === 'optimal') {
    lines.push(`总收益: ${solution.totalRevenue}   总成本: ${solution.totalCost}   总曝光: ${solution.totalExposure}（下限 ${input.exposureLowerBound}）`);
    lines.push('分渠道预算核销:');
    for (const ch of cert.channels) {
      lines.push(`  ${ch.id}: 花费 ${ch.spend} / 预算 ${ch.budget}（余量 ${ch.slack}）`);
    }
    lines.push('投放方案:');
    for (const a of cert.allocations) {
      lines.push(`  ${a.groupId} [${a.channel}] 量=${a.quantity} 成本=${a.cost} 曝光=${a.exposure} 收益=${a.revenue}`);
    }
  }
  lines.push(`最优性证据: DP 状态数 ${cert.proof.statesExplored}，前沿哈希 ${cert.proof.frontierHash.slice(0, 16)}…`);
  const bf = cert.proof.bruteForce;
  lines.push(
    bf.checked
      ? `穷举对照: ${bf.combinations} 种组合，结论${bf.match ? '一致' : '不一致！'}`
      : `穷举对照: 跳过（${bf.reason}）`,
  );
  lines.push(`证书哈希: ${cert.certificateHash}`);
  if (certPath) lines.push(`证书已写入: ${certPath}`);
  console.log(lines.join('\n'));
}

function cmdVerify(args: string[]): void {
  const [configPath, certPath] = args;
  if (!configPath || !certPath) throw new Error('用法: verify <config.json> <cert.json>');
  const input = loadInput(configPath);
  const cert = JSON.parse(readFileSync(certPath, 'utf8')) as BudgetCertificate;
  const result = verifyCertificate(input, cert);
  if (result.ok) {
    console.log('证书复核通过：约束满足，且经重新精确求解确认为收益最大、并列成本最低。');
  } else {
    console.error('证书复核失败:');
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  }
}

function cmdBrute(args: string[]): void {
  const configPath = args[0];
  if (!configPath) throw new Error('缺少配置文件路径');
  const input = loadInput(configPath);
  const solution = bruteForce(input);
  console.log(JSON.stringify(solution, null, 2));
}

function cmdSample(args: string[]): void {
  const outIdx = args.indexOf('--out');
  const sample = generateSample();
  const text = JSON.stringify(sample, null, 2) + '\n';
  if (outIdx >= 0 && args[outIdx + 1]) {
    writeFileSync(args[outIdx + 1], text);
    console.log(`样例配置已写入: ${args[outIdx + 1]}`);
  } else {
    process.stdout.write(text);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'solve':
      cmdSolve(rest);
      break;
    case 'verify':
      cmdVerify(rest);
      break;
    case 'brute':
      cmdBrute(rest);
      break;
    case 'sample':
      cmdSample(rest);
      break;
    default:
      process.stdout.write(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main();

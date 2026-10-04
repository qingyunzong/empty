import { loadInstance } from "./instance";
import { solve } from "./solver";
import { solveDp } from "./dp";
import { buildCertificate, formatCertificate, validateCertificate } from "./certificate";

function usage(): never {
  console.error("usage: node cli.js <instance.json> [--verify] [--json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const instancePath = args.find((a) => !a.startsWith("--"));
if (!instancePath) usage();
const doVerify = args.includes("--verify");
const asJson = args.includes("--json");

const instance = loadInstance(instancePath!);
const started = process.hrtime.bigint();
const solution = solve(instance);
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

const certificate = buildCertificate(instance, solution.route);
const validation = validateCertificate(instance, certificate);
if (!validation.ok) {
  console.error("INTERNAL ERROR: certificate failed validation:");
  for (const e of validation.errors) console.error("  - " + e);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(certificate, null, 2));
} else {
  console.log(formatCertificate(instance, certificate));
  console.log(`\nCertificate self-check: OK   (solved in ${elapsedMs.toFixed(1)} ms)`);
}

if (doVerify) {
  const cross = solveDp(instance);
  const match = cross.profit === solution.profit && cross.distance === solution.distance;
  if (!match) {
    console.error(
      `CROSS-CHECK FAILED: branch&bound profit=${solution.profit} dist=${solution.distance}, ` +
        `subset-DP profit=${cross.profit} dist=${cross.distance}`,
    );
    process.exit(1);
  }
  console.log(`Cross-check vs independent subset-DP solver: OK (profit=${cross.profit}, distance=${cross.distance})`);
}

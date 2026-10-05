import { certify } from "./certificate";
import type { World } from "./model";
import { runScenario } from "./scenario";

function printLedger(world: World): void {
  console.log("== 物料账（分录） ==");
  console.log("seq  material  from      to        qty  reason                order/stage");
  for (const entry of world.ledger) {
    const ref = entry.order ? `${entry.order}/${entry.stage ?? "-"}` : "-";
    console.log(
      `${String(entry.seq).padEnd(4)} ${entry.material.padEnd(9)} ${entry.from.padEnd(9)} ${entry.to.padEnd(9)} ` +
        `${String(entry.qty).padEnd(4)} ${entry.reason.padEnd(21)} ${ref}`,
    );
  }
  console.log("\n== 物料账户汇总 ==");
  for (const [material, account] of Object.entries(world.materials)) {
    console.log(`${material}: ${JSON.stringify(account)}`);
  }
}

const { world, events, replayed } = runScenario();
printLedger(world);

const certLive = certify(world);
const certReplay = certify(replayed);

console.log("\n== 状态证书（增量） ==");
console.log(JSON.stringify(certLive, null, 2));
console.log("\n== 从头重放对照 ==");
console.log(`事件数: ${events.length}`);
console.log(`增量证书 sha256: ${certLive.sha256}`);
console.log(`重放证书 sha256: ${certReplay.sha256}`);
const match = certLive.sha256 === certReplay.sha256;
console.log(match ? "对照结果: 一致 [OK]" : "对照结果: 不一致 [MISMATCH]");
if (!match) {
  process.exitCode = 1;
}

import { stateCertificate } from './certificate.js';
import { buildLedger, formatLedger } from './ledger.js';
import { replayCertificate } from './replay.js';
import { ProductionSystem } from './system.js';

const sys = new ProductionSystem();

sys.initStock({ steel: 100, plastic: 60, carton: 40 });
sys.registerEquipment('CNC', 2);
sys.registerEquipment('PACK', 1);

sys.placeOrder('O1', [
  {
    jobId: 'J1',
    stages: [
      { stageId: 'cut', materials: { steel: 10 }, equipment: { CNC: 1 }, recovery: { steel: 10 } },
      { stageId: 'assemble', materials: { steel: 4, plastic: 6 }, equipment: { CNC: 1 }, recovery: { plastic: 4 } },
      { stageId: 'pack', materials: { plastic: 2, carton: 2 }, equipment: { PACK: 1 }, recovery: {} },
    ],
  },
  {
    jobId: 'J2',
    stages: [{ stageId: 'cut', materials: { steel: 8 }, equipment: { CNC: 1 }, recovery: { steel: 8 } }],
  },
]);

// J1: cut 完成 -> assemble 失败（plastic 可回收 4，其余损耗）-> 重试 -> 完成全部阶段
sys.startStage('J1');
sys.completeStage('J1');
sys.startStage('J1');
sys.failStage('J1', 'weld crack');
sys.retry('J1');
sys.completeStage('J1');
sys.startStage('J1');
sys.completeStage('J1');

// J2: cut 进行中，整单取消 -> 在制料逆向补料退回
sys.startStage('J2');
sys.cancelOrder('O1');

console.log('=== 事件流（显式顺序） ===');
for (const event of sys.events) {
  const { seq, ...rest } = event;
  console.log(`#${String(seq).padStart(2)} ${JSON.stringify(rest)}`);
}

console.log('\n=== 物料账 ===');
console.log(formatLedger(buildLedger(sys.events)));

const live = stateCertificate(sys.state, sys.events.length);
const replayed = replayCertificate(sys.events);
console.log('\n=== 状态证书 ===');
console.log(`live   : ${live}`);
console.log(`replay : ${replayed}`);
console.log(`match  : ${live === replayed}`);

console.log('\n=== 终态库存 ===');
console.log(JSON.stringify(sys.state.materials, null, 2));
console.log('scrapped:', JSON.stringify(sys.state.scrapped));

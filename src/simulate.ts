/**
 * 模拟：策略撤销与长事务提交交错。
 *
 * 时间线：
 *   t1  策略 v1：alice 获得 doc/A、doc/B 的 read+write
 *   t2  alice 打开会话 S（快照绑定 v1），开始长事务 T
 *   t3  T 读 doc/A、doc/B            —— 按 v1 判定（命中旧权限）
 *   t4  T 缓冲写 doc/A、doc/B        —— 按 v1 乐观放行
 *   t5  管理员撤销 alice 对 doc/B 的写权限  => 策略推进到 v2
 *   t6  T 继续读 doc/B               —— 仍按 v1 放行（旧快照命中证据）
 *   t7  T 提交                       —— 按 v2 重核：doc/A 过、doc/B 拒
 *                                    —— 整体中止，一条都不落库
 *   t8  alice 重开会话（绑定 v2），只写 doc/A，提交成功（新版本命中证据）
 */
import { DataStore, EvidenceLog, PolicyStore, openSession } from "./index.js";

function banner(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const policy = new PolicyStore();
const store = new DataStore();
const log = new EvidenceLog();

banner("t1 授权：alice -> read/write doc/A, doc/B（策略推进到 v4）");
policy.grant({ subject: "alice", action: "read", resource: "doc/A" });
policy.grant({ subject: "alice", action: "write", resource: "doc/A" });
policy.grant({ subject: "alice", action: "read", resource: "doc/B" });
policy.grant({ subject: "alice", action: "write", resource: "doc/B" });
console.log(`latest policy version = v${policy.latestVersion}`);

banner("t2 打开长事务会话（快照绑定当前版本）");
const session = openSession("alice", policy, store, log);
console.log(`session bound to snapshot v${session.boundVersion}`);
const tx = session.beginTransaction();

banner("t3 长事务读（按绑定快照判定）");
console.log(`read doc/A => ${tx.read("doc/A") ?? "(empty)"}`);
console.log(`read doc/B => ${tx.read("doc/B") ?? "(empty)"}`);

banner("t4 缓冲写动作（按快照乐观放行，未落库）");
tx.write("doc/A", "A-written-by-long-tx");
tx.write("doc/B", "B-written-by-long-tx");
console.log(`staged 2 writes; store still: ${JSON.stringify(store.entries())}`);

banner("t5 管理员撤销 alice 对 doc/B 的写权限（策略 v4 -> v5）");
policy.revoke({ subject: "alice", action: "write", resource: "doc/B" });
console.log(`latest policy version = v${policy.latestVersion}`);

banner("t6 长事务继续读 doc/B（旧快照仍放行）");
console.log(`read doc/B => ${tx.read("doc/B") ?? "(empty)"}`);

banner("t7 提交：按最新版本重核全部缓冲写，失败则全不提交");
const result = tx.commit();
console.log(`commit status = ${result.status} (rechecked at v${result.recheckedVersion})`);
if (result.status === "aborted") {
  for (const f of result.failures) {
    console.log(`  failure: ${f.resource} - ${f.reason}`);
  }
}
console.log(`store after abort = ${JSON.stringify(store.entries())} (应为空：一条都不落库)`);

banner("t8 重开会话（绑定 v5），只写 doc/A，提交成功");
const session2 = openSession("alice", policy, store, log);
console.log(`session bound to snapshot v${session2.boundVersion}`);
const tx2 = session2.beginTransaction();
tx2.write("doc/A", "A-committed-under-v5");
const result2 = tx2.commit();
console.log(`commit status = ${result2.status} (rechecked at v${result2.recheckedVersion})`);
console.log(`store = ${JSON.stringify(store.entries())}`);

banner("命中证据（全部判定记录）");
console.log(log.render());

banner("旧快照命中（判定版本落后于最新版本且放行）");
for (const e of log.staleHits()) {
  console.log(`  #${e.seq} ${e.phase} ${e.action} ${e.resource}: 用 v${e.checkedVersion} 放行，当时最新已是 v${e.latestVersion}`);
}

banner("提交重核（新版本判定）");
for (const e of log.rechecks()) {
  console.log(`  #${e.seq} ${e.action} ${e.resource}: v${e.checkedVersion} -> ${e.decision.toUpperCase()} ${e.note}`);
}

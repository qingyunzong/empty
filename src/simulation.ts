/**
 * 模拟：策略撤销与长事务提交交错。
 *
 * 时间线：
 *  t1  发布策略 v1：alice 可读写 doc，bob 可读写 doc
 *  t2  长会话 S-alice 打开（绑定 v1），开启长事务 T，暂存两条写
 *  t3  管理员发布 v2：撤销 alice 的 doc:write（bob 不变）
 *  t4  T 期间 alice 读权限仍命中旧快照（旧命中证据）
 *  t5  新会话 S2-alice 绑定 v2，读权限命中新策略（新命中证据）
 *  t6  T 提交：按 v2 重核全部写动作 -> alice 写被拒 -> 全不提交
 *  t7  新会话提交 bob 的写（v2 下仍允许）-> 正常落库
 */
import { DataStore, PolicyStore, formatEvidence } from "./authz.js";

const log = (line = "") => console.log(line);

// t1: 初始策略 v1
const policies = new PolicyStore({
  alice: ["doc:read", "doc:write"],
  bob: ["doc:read", "doc:write"],
});
const data = new DataStore();
log("== t1 发布策略 v1: alice[doc:read,doc:write] bob[doc:read,doc:write] ==");

// t2: 长会话绑定 v1，开启长事务并暂存写
const sAlice = policies.openSession("S-alice");
const txn = sAlice.begin();
txn.stageWrite("alice", "doc:write", "doc:1", "alice-draft-1");
txn.stageWrite("alice", "doc:write", "doc:2", "alice-draft-2");
log(`== t2 会话 ${sAlice.id} 绑定快照 v${sAlice.boundVersion}，长事务暂存 2 条写 ==`);

// t3: 撤销 alice 的写权限，发布 v2
policies.publish({
  alice: ["doc:read"],
  bob: ["doc:read", "doc:write"],
});
log("== t3 管理员撤销 alice:doc:write，发布策略 v2 ==");

// t4: 长事务期间，旧会话仍读到旧权限（旧命中证据）
log(`== t4 旧会话读权限（快照 v${sAlice.boundVersion}）==`);
log(`  旧命中: S-alice.can(alice, doc:write) = ${sAlice.can("alice", "doc:write")}  (快照 v${sAlice.boundVersion} 仍允许)`);
log(`  旧命中: S-alice.can(alice, doc:read)  = ${sAlice.can("alice", "doc:read")}`);

// t5: 新会话绑定 v2，读权限命中新策略（新命中证据）
const sAlice2 = policies.openSession("S2-alice");
log(`== t5 新会话 S2-alice 绑定快照 v${sAlice2.boundVersion} ==`);
log(`  新命中: S2-alice.can(alice, doc:write) = ${sAlice2.can("alice", "doc:write")}  (最新 v${sAlice2.boundVersion} 已撤销)`);

// t6: 长事务提交 —— 按最新版本重核全部写动作
log("== t6 长事务提交：按最新版本 v2 重核全部写动作 ==");
const result = txn.commit(data);
log(formatEvidence(result));
log(`  数据库键集合: [${data.keys().join(", ")}]  <- 全不提交，保持为空`);

// t7: 新会话提交 bob 的写（v2 下仍允许）
log("== t7 新会话提交 bob 的写（v2 下仍允许）==");
const sBob = policies.openSession("S-bob");
const txnBob = sBob.begin();
txnBob.stageWrite("bob", "doc:write", "doc:9", "bob-final");
const bobResult = txnBob.commit(data);
log(formatEvidence(bobResult));
log(`  数据库键集合: [${data.keys().join(", ")}]  <- bob 的写正常落库`);

log("== 模拟结束 ==");

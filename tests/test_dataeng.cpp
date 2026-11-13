#include "dataeng.hpp"

#include <cstdio>
#include <string>

using namespace dataeng;

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    ++checks;                                                                \
    if (!(cond)) {                                                           \
      ++failures;                                                            \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);            \
    }                                                                        \
  } while (0)

static RowChange change(Xid xid, ThreadId thread, Scn scn,
                        std::string rowKey) {
  RowChange c;
  c.xid = xid;
  c.thread = thread;
  c.scn = scn;
  c.op = OpKind::Insert;
  c.tableName = "T";
  c.rowKey = std::move(rowKey);
  return c;
}

static CommitRecord commitRec(Xid xid, ThreadId thread, Scn scn,
                              SubScn subScn = 0) {
  CommitRecord r;
  r.xid = xid;
  r.thread = thread;
  r.scn = scn;
  r.subScn = subScn;
  return r;
}

// 跨 thread 合并:按 (SCN, subSCN) 排序,相同则以 xid 公开并列键定序。
static void testMergeOrderAndTieBreak() {
  TxnMerger m;
  const Xid a{1, 1, 100}, b{2, 5, 7}, c{1, 2, 99};
  m.addChange(change(a, 1, 10, "a1"));
  m.addChange(change(b, 2, 20, "b1"));
  m.addChange(change(c, 1, 15, "c1"));
  // b 与 c 提交 SCN/subSCN 完全相同,xid b > c,所以 c 先输出。
  m.commit(commitRec(a, 1, 500, 1));
  m.commit(commitRec(b, 2, 600, 0));
  m.commit(commitRec(c, 1, 600, 0));
  const auto out = m.drain(1000);
  CHECK(out.size() == 3);
  CHECK(out[0].xid == a);
  CHECK(out[1].xid == c);
  CHECK(out[2].xid == b);
  CHECK(m.committedCount() == 0);
}

// 行变化先缓冲到事务,提交前不可见;输出按版本升序。
static void testBufferingUntilCommit() {
  TxnMerger m;
  const Xid x{3, 1, 1};
  const Version v1 = m.addChange(change(x, 1, 10, "r1"));
  const Version v2 = m.addChange(change(x, 1, 11, "r2"));
  CHECK(v1 == 1 && v2 == 2);
  CHECK(m.drain(1000).empty()); // 未提交,无输出
  m.commit(commitRec(x, 1, 700));
  const auto out = m.drain(1000);
  CHECK(out.size() == 1);
  CHECK(out[0].changes.size() == 2);
  CHECK(out[0].changes[0].rowKey == "r1");
  CHECK(out[0].changes[1].rowKey == "r2");
}

// 回滚与补偿记录必须撤销正确版本;错误版本抛异常。
static void testUndoExactVersion() {
  TxnMerger m;
  const Xid x{4, 1, 1};
  m.addChange(change(x, 1, 10, "keep1"));
  m.addChange(change(x, 1, 11, "drop"));
  m.addChange(change(x, 1, 12, "keep2"));

  UndoRecord bad;
  bad.xid = x;
  bad.thread = 1;
  bad.targetVersion = 99;
  bool threw = false;
  try {
    m.applyUndo(bad);
  } catch (const UndoVersionError &) {
    threw = true;
  }
  CHECK(threw);

  UndoRecord undo;
  undo.xid = x;
  undo.thread = 1;
  undo.targetVersion = 2;
  undo.compensation = true; // 补偿记录同样精确撤销
  m.applyUndo(undo);

  // 重复撤销同一版本必须报错。
  threw = false;
  try {
    m.applyUndo(undo);
  } catch (const UndoVersionError &) {
    threw = true;
  }
  CHECK(threw);

  m.commit(commitRec(x, 1, 800));
  const auto out = m.drain(1000);
  CHECK(out.size() == 1);
  CHECK(out[0].changes.size() == 2);
  CHECK(out[0].changes[0].rowKey == "keep1");
  CHECK(out[0].changes[1].rowKey == "keep2");
}

// 回滚到保存点:只撤销保存点之后的版本。
static void testRollbackToSavepoint() {
  TxnMerger m;
  const Xid x{5, 1, 1};
  m.addChange(change(x, 1, 10, "v1"));
  m.addChange(change(x, 1, 11, "v2"));
  m.addChange(change(x, 1, 12, "v3"));
  m.rollbackToVersion(x, 1, 1);
  m.commit(commitRec(x, 1, 900));
  const auto out = m.drain(1000);
  CHECK(out.size() == 1);
  CHECK(out[0].changes.size() == 1);
  CHECK(out[0].changes[0].rowKey == "v1");
}

// thread reset 开启新世代:旧世代未决事务作废,同一 xid 可复用。
static void testThreadResetGeneration() {
  TxnMerger m;
  const Xid x{6, 1, 1};
  m.addChange(change(x, 1, 10, "old-gen"));
  CHECK(m.resetThread(1) == 1); // 作废旧世代未决事务
  CHECK(m.generationOf(1) == 1);
  CHECK(m.pendingCount() == 0);

  // 新世代中同一 xid 是全新事务,与旧世代缓冲互不可见。
  m.addChange(change(x, 1, 5, "new-gen"));
  m.commit(commitRec(x, 1, 100));
  const auto out = m.drain(1000);
  CHECK(out.size() == 1);
  CHECK(out[0].generation == 1);
  CHECK(out[0].changes.size() == 1);
  CHECK(out[0].changes[0].rowKey == "new-gen");
}

// 水位不得越过未决事务;drain 被钳制到安全水位。
static void testWatermarkBlockedByPending() {
  TxnMerger m;
  const Xid pending{7, 1, 1}, done{7, 2, 1};
  m.addChange(change(pending, 1, 100, "p1")); // 未决事务,首 SCN=100
  m.addChange(change(done, 2, 150, "d1"));
  m.commit(commitRec(done, 2, 200));

  CHECK(m.safeWatermark() == 99);
  CHECK(m.advanceWatermark(1000) == 99);
  CHECK(m.drain(1000).empty()); // 提交 SCN 200 越过水位,不得输出
  CHECK(m.committedCount() == 1);

  m.abort(pending, 1); // 未决事务终结,水位放行
  CHECK(m.safeWatermark() > 1000);
  const auto out = m.drain(1000);
  CHECK(out.size() == 1);
  CHECK(out[0].xid == done);
}

int main() {
  testMergeOrderAndTieBreak();
  testBufferingUntilCommit();
  testUndoExactVersion();
  testRollbackToSavepoint();
  testThreadResetGeneration();
  testWatermarkBlockedByPending();
  std::printf("%d checks, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}

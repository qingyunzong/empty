#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace dataeng {

using Scn = std::uint64_t;
using SubScn = std::uint32_t;
using ThreadId = std::uint32_t;
using Generation = std::uint32_t;
using Version = std::uint64_t;

// 事务 id(undo segment / slot / sequence),同时作为提交顺序相同
// 时的公开并列键(tie-break key)。
struct Xid {
  std::uint32_t usn = 0;
  std::uint32_t slot = 0;
  std::uint32_t sequence = 0;
  friend auto operator<=>(const Xid &, const Xid &) = default;
  friend bool operator==(const Xid &, const Xid &) = default;
};

enum class OpKind : std::uint8_t { Insert, Update, Delete };

// 一条 redo 行变化记录。
struct RowChange {
  Xid xid{};
  ThreadId thread = 0;
  Scn scn = 0;
  SubScn subScn = 0;
  OpKind op = OpKind::Insert;
  std::string tableName;
  std::string rowKey;
  std::string beforeImage;
  std::string afterImage;
};

// 回滚 / 补偿记录:撤销事务内某个特定版本的行变化。
struct UndoRecord {
  Xid xid{};
  ThreadId thread = 0;
  Scn scn = 0;
  Version targetVersion = 0; // 被撤销的行变化版本
  bool compensation = false; // 补偿日志记录(CLR)
};

struct CommitRecord {
  Xid xid{};
  ThreadId thread = 0;
  Scn scn = 0;
  SubScn subScn = 0;
};

// 缓冲后的行变化,带事务内单调递增的版本号。
struct BufferedChange : RowChange {
  Version version = 0;
  bool undone = false;
};

// 提交排序键:(SCN, subSCN) 相同时以事务 id 作为公开并列键。
struct CommitKey {
  Scn scn = 0;
  SubScn subScn = 0;
  Xid tie{};
  friend auto operator<=>(const CommitKey &, const CommitKey &) = default;
  friend bool operator==(const CommitKey &, const CommitKey &) = default;
};

// 已提交、可按提交顺序输出的事务。
struct CommittedTxn {
  Xid xid{};
  ThreadId thread = 0;
  Generation generation = 0;
  CommitKey key{};
  std::vector<BufferedChange> changes; // 已撤销版本被剔除,按版本升序
};

class UnknownTxnError : public std::runtime_error {
public:
  UnknownTxnError() : std::runtime_error("unknown transaction") {}
};

class UndoVersionError : public std::runtime_error {
public:
  UndoVersionError()
      : std::runtime_error("undo record targets a missing or already-undone "
                           "change version") {}
};

// 可嵌入的事务排序组件:合并多个 redo thread 的记录流,
// 缓冲行变化到事务,按提交顺序输出,并维护安全水位。
class TxnMerger {
public:
  // thread reset:开启新世代。该 thread 旧世代下仍未决的事务
  // 随之作废(redo 流已终结,不可能再提交),返回作废数量。
  std::size_t resetThread(ThreadId thread);

  Generation generationOf(ThreadId thread) const;

  // 缓冲一条行变化,返回分配的版本号。
  Version addChange(const RowChange &change);

  // 应用回滚 / 补偿记录:精确撤销 targetVersion 指定的版本。
  // 版本不存在或已被撤销时抛 UndoVersionError。
  void applyUndo(const UndoRecord &undo);

  // 回滚到保存点:撤销版本号大于 savepointVersion 的所有变化。
  void rollbackToVersion(const Xid &xid, ThreadId thread,
                         Version savepointVersion);

  // 整体回滚:丢弃事务全部缓冲变化。
  void abort(const Xid &xid, ThreadId thread);

  // 提交:事务进入已提交集合,按 CommitKey 参与全局排序。
  void commit(const CommitRecord &rec);

  // 安全水位:不超过任何未决事务的首个 SCN。
  // 无未决事务时返回 Scn 最大值。
  Scn safeWatermark() const;

  // 期望水位被钳制到安全水位之内。
  Scn advanceWatermark(Scn desired) const { return std::min(desired, safeWatermark()); }

  // 取出提交 SCN <= min(upToScn, safeWatermark()) 的已提交事务,
  // 按 CommitKey 升序(提交顺序相同则按公开并列键)。
  std::vector<CommittedTxn> drain(Scn upToScn);

  std::size_t pendingCount() const { return pending_.size(); }
  std::size_t committedCount() const { return committed_.size(); }

private:
  // 事务身份:thread + 世代 + xid。reset 后同一 xid 属于新事务。
  struct TxnId {
    ThreadId thread = 0;
    Generation generation = 0;
    Xid xid{};
    friend auto operator<=>(const TxnId &, const TxnId &) = default;
    friend bool operator==(const TxnId &, const TxnId &) = default;
  };

  struct Txn {
    TxnId id{};
    Scn firstScn = 0;
    Version nextVersion = 1;
    std::map<Version, BufferedChange> changes;
  };

  Txn &findPending(const Xid &xid, ThreadId thread);

  std::map<ThreadId, Generation> generations_;
  std::map<TxnId, Txn> pending_;
  std::multimap<CommitKey, CommittedTxn> committed_;
};

} // namespace dataeng

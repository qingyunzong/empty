#include "dataeng.hpp"

#include <algorithm>
#include <limits>

namespace dataeng {

std::size_t TxnMerger::resetThread(ThreadId thread) {
  const Generation current = generationOf(thread);
  std::size_t discarded = 0;
  for (auto it = pending_.begin(); it != pending_.end();) {
    if (it->first.thread == thread && it->first.generation == current) {
      it = pending_.erase(it);
      ++discarded;
    } else {
      ++it;
    }
  }
  generations_[thread] = current + 1;
  return discarded;
}

Generation TxnMerger::generationOf(ThreadId thread) const {
  const auto it = generations_.find(thread);
  return it == generations_.end() ? 0 : it->second;
}

Version TxnMerger::addChange(const RowChange &change) {
  const TxnId id{change.thread, generationOf(change.thread), change.xid};
  auto [it, inserted] = pending_.try_emplace(id);
  Txn &txn = it->second;
  if (inserted) {
    txn.id = id;
    txn.firstScn = change.scn;
  } else {
    txn.firstScn = std::min(txn.firstScn, change.scn);
  }
  BufferedChange buffered;
  static_cast<RowChange &>(buffered) = change;
  buffered.version = txn.nextVersion++;
  txn.changes.emplace(buffered.version, buffered);
  return buffered.version;
}

TxnMerger::Txn &TxnMerger::findPending(const Xid &xid, ThreadId thread) {
  const TxnId id{thread, generationOf(thread), xid};
  const auto it = pending_.find(id);
  if (it == pending_.end())
    throw UnknownTxnError{};
  return it->second;
}

void TxnMerger::applyUndo(const UndoRecord &undo) {
  Txn &txn = findPending(undo.xid, undo.thread);
  const auto it = txn.changes.find(undo.targetVersion);
  if (it == txn.changes.end() || it->second.undone)
    throw UndoVersionError{};
  it->second.undone = true;
}

void TxnMerger::rollbackToVersion(const Xid &xid, ThreadId thread,
                                  Version savepointVersion) {
  Txn &txn = findPending(xid, thread);
  for (auto &[version, change] : txn.changes) {
    if (version > savepointVersion)
      change.undone = true;
  }
}

void TxnMerger::abort(const Xid &xid, ThreadId thread) {
  const TxnId id{thread, generationOf(thread), xid};
  pending_.erase(id);
}

void TxnMerger::commit(const CommitRecord &rec) {
  const TxnId id{rec.thread, generationOf(rec.thread), rec.xid};
  CommittedTxn committed;
  committed.xid = rec.xid;
  committed.thread = rec.thread;
  committed.generation = id.generation;
  committed.key = CommitKey{rec.scn, rec.subScn, rec.xid};
  if (const auto it = pending_.find(id); it != pending_.end()) {
    for (const auto &[version, change] : it->second.changes) {
      if (!change.undone)
        committed.changes.push_back(change);
    }
    pending_.erase(it);
  }
  committed_.emplace(committed.key, std::move(committed));
}

Scn TxnMerger::safeWatermark() const {
  if (pending_.empty())
    return std::numeric_limits<Scn>::max();
  Scn earliest = std::numeric_limits<Scn>::max();
  for (const auto &[id, txn] : pending_)
    earliest = std::min(earliest, txn.firstScn);
  return earliest == 0 ? 0 : earliest - 1;
}

std::vector<CommittedTxn> TxnMerger::drain(Scn upToScn) {
  const Scn limit = std::min(upToScn, safeWatermark());
  std::vector<CommittedTxn> out;
  for (auto it = committed_.begin();
       it != committed_.end() && it->first.scn <= limit;) {
    out.push_back(std::move(it->second));
    it = committed_.erase(it);
  }
  return out;
}

} // namespace dataeng

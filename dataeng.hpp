#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <unordered_map>
#include <vector>

namespace dataeng {

using DocId = std::uint32_t;
using SegmentId = std::uint32_t;
using SegmentGen = std::uint64_t;
using DeleteGen = std::uint64_t;

// Doc-map sentinel: the input document is not copied to the merge output.
inline constexpr DocId kDroppedDoc = ~DocId{0};

// Deletion state of one segment generation.
//
// Deletions are stored as a bitset indexed by doc id. Every bit is paired
// with the delete generation that set it, which acts as a receipt guard:
// a receipt whose delete generation is not newer than the recorded one is
// stale and dropped, so an old receipt can never overwrite a newer bitset
// entry.
//
// Not thread-safe; callers provide external synchronization.
class SegmentDeletes {
public:
  explicit SegmentDeletes(SegmentGen segment_generation);

  SegmentGen segment_generation() const noexcept { return segment_gen_; }
  // Highest delete generation ever applied to this segment.
  DeleteGen delete_generation() const noexcept { return max_delete_gen_; }

  // Applies one delete receipt. Returns false (and changes nothing) when
  // the receipt is stale, i.e. its delete generation is not newer than the
  // generation already recorded for `doc`.
  bool apply_delete(DeleteGen del_gen, DocId doc);

  bool is_deleted(DocId doc) const noexcept;
  // Delete generation recorded for `doc`; 0 means the document is live.
  DeleteGen delete_generation_of(DocId doc) const noexcept;
  // A document is visible in a snapshot when no delete with
  // delete generation <= snapshot has been recorded for it.
  bool is_visible_at(DocId doc, DeleteGen snapshot) const noexcept;

  std::size_t deleted_count() const noexcept { return deleted_count_; }
  std::size_t doc_capacity() const noexcept { return doc_gens_.size(); }

  // Delete generation per doc id (0 = live); the bitset mirrors entries > 0.
  const std::vector<DeleteGen>& doc_generations() const noexcept {
    return doc_gens_;
  }

private:
  void ensure_capacity(DocId doc);

  SegmentGen segment_gen_;
  DeleteGen max_delete_gen_ = 0;
  std::size_t deleted_count_ = 0;
  std::vector<std::uint64_t> bits_; // bitset indexed by doc id
  std::vector<DeleteGen> doc_gens_; // per-doc receipt guard
};

struct MergeSpec {
  std::vector<SegmentId> inputs;
  SegmentId output = 0;
  SegmentGen output_segment_gen = 0;
  // doc_maps[i][input_doc] = output doc id, or kDroppedDoc when the merge
  // reader did not copy the document. Docs beyond a map's size are dropped.
  std::vector<std::vector<DocId>> doc_maps;
};

// Owns the deletion state of every live segment and orchestrates merges.
//
// Merge semantics:
//  - begin_merge() snapshots nothing eagerly; it only records the spec and
//    the snapshot delete generation. Deletes already visible in the snapshot
//    (delete generation <= snapshot) are the ones the merge reader observes.
//  - Deletes applied to input segments while the merge is running keep
//    landing on the input state and are remapped onto the output segment at
//    commit time through the doc maps.
//  - commit_merge() unions every input deletion (snapshot-visible or newer)
//    into the output segment so per-document visibility is preserved, then
//    closes the inputs.
//  - Receipts carrying a stale segment generation or a stale delete
//    generation are rejected and can never overwrite newer state.
class DeletionRegistry {
public:
  // Opens (or re-generates) a segment. Reopening with a newer segment
  // generation resets its deletion state; opening with a generation that is
  // not newer than the current one is a no-op.
  SegmentDeletes& open_segment(SegmentId id, SegmentGen gen);
  // Fails for unknown segments and for inputs of the active merge.
  bool close_segment(SegmentId id);

  bool has_segment(SegmentId id) const { return segments_.count(id) != 0; }
  const SegmentDeletes* find(SegmentId id) const;

  // Applies a delete receipt. Rejected (returns false) when the segment is
  // unknown or `seg_gen` does not match the segment's current generation.
  bool apply_delete(SegmentId id, SegmentGen seg_gen, DeleteGen del_gen,
                   DocId doc);

  bool merge_active() const noexcept { return merge_.has_value(); }
  void begin_merge(MergeSpec spec, DeleteGen snapshot);
  SegmentId commit_merge();
  void abort_merge();

private:
  struct ActiveMerge {
    MergeSpec spec;
    DeleteGen snapshot;
    bool created_output;
  };

  std::unordered_map<SegmentId, SegmentDeletes> segments_;
  std::optional<ActiveMerge> merge_;
};

} // namespace dataeng

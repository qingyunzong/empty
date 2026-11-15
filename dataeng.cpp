#include "dataeng.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace dataeng {

namespace {
constexpr std::size_t kBitsPerWord = 64;
}

SegmentDeletes::SegmentDeletes(SegmentGen segment_generation)
    : segment_gen_(segment_generation) {}

void SegmentDeletes::ensure_capacity(DocId doc) {
  if (doc < doc_gens_.size()) {
    return;
  }
  const std::size_t n = static_cast<std::size_t>(doc) + 1;
  doc_gens_.resize(n, 0);
  bits_.resize((n + kBitsPerWord - 1) / kBitsPerWord, 0);
}

bool SegmentDeletes::apply_delete(DeleteGen del_gen, DocId doc) {
  ensure_capacity(doc);
  if (del_gen <= doc_gens_[doc]) {
    return false; // stale or duplicate receipt
  }
  if (doc_gens_[doc] == 0) {
    bits_[doc / kBitsPerWord] |= std::uint64_t{1} << (doc % kBitsPerWord);
    ++deleted_count_;
  }
  doc_gens_[doc] = del_gen;
  max_delete_gen_ = std::max(max_delete_gen_, del_gen);
  return true;
}

bool SegmentDeletes::is_deleted(DocId doc) const noexcept {
  return doc < doc_gens_.size() &&
         ((bits_[doc / kBitsPerWord] >> (doc % kBitsPerWord)) & 1u) != 0;
}

DeleteGen SegmentDeletes::delete_generation_of(DocId doc) const noexcept {
  return doc < doc_gens_.size() ? doc_gens_[doc] : 0;
}

bool SegmentDeletes::is_visible_at(DocId doc, DeleteGen snapshot) const
    noexcept {
  const DeleteGen gen = delete_generation_of(doc);
  return gen == 0 || gen > snapshot;
}

SegmentDeletes& DeletionRegistry::open_segment(SegmentId id, SegmentGen gen) {
  auto it = segments_.find(id);
  if (it != segments_.end()) {
    if (gen <= it->second.segment_generation()) {
      return it->second;
    }
    it->second = SegmentDeletes(gen);
    return it->second;
  }
  return segments_.emplace(id, SegmentDeletes(gen)).first->second;
}

bool DeletionRegistry::close_segment(SegmentId id) {
  if (merge_) {
    const auto& inputs = merge_->spec.inputs;
    if (std::find(inputs.begin(), inputs.end(), id) != inputs.end()) {
      return false;
    }
  }
  return segments_.erase(id) != 0;
}

const SegmentDeletes* DeletionRegistry::find(SegmentId id) const {
  const auto it = segments_.find(id);
  return it == segments_.end() ? nullptr : &it->second;
}

bool DeletionRegistry::apply_delete(SegmentId id, SegmentGen seg_gen,
                                    DeleteGen del_gen, DocId doc) {
  auto it = segments_.find(id);
  if (it == segments_.end() || it->second.segment_generation() != seg_gen) {
    return false; // unknown segment or stale segment-generation receipt
  }
  return it->second.apply_delete(del_gen, doc);
}

void DeletionRegistry::begin_merge(MergeSpec spec, DeleteGen snapshot) {
  if (merge_) {
    throw std::logic_error("dataeng: a merge is already active");
  }
  if (spec.inputs.empty()) {
    throw std::invalid_argument("dataeng: merge needs at least one input");
  }
  if (spec.doc_maps.size() != spec.inputs.size()) {
    throw std::invalid_argument("dataeng: doc_maps must match inputs");
  }
  for (const SegmentId in : spec.inputs) {
    if (in == spec.output) {
      throw std::invalid_argument("dataeng: merge output must differ from inputs");
    }
    if (!segments_.count(in)) {
      throw std::invalid_argument("dataeng: unknown merge input segment");
    }
  }
  const bool created_output = !segments_.count(spec.output);
  open_segment(spec.output, spec.output_segment_gen);
  merge_ = ActiveMerge{std::move(spec), snapshot, created_output};
}

SegmentId DeletionRegistry::commit_merge() {
  if (!merge_) {
    throw std::logic_error("dataeng: no active merge");
  }
  ActiveMerge active = std::move(*merge_);
  merge_.reset();

  SegmentDeletes& out = segments_.at(active.spec.output);
  for (std::size_t i = 0; i < active.spec.inputs.size(); ++i) {
    const SegmentDeletes& in = segments_.at(active.spec.inputs[i]);
    const std::vector<DocId>& map = active.spec.doc_maps[i];
    const std::vector<DeleteGen>& gens = in.doc_generations();
    const std::size_t limit = std::min(gens.size(), map.size());
    for (DocId doc = 0; doc < limit; ++doc) {
      const DeleteGen gen = gens[doc];
      if (gen == 0 || map[doc] == kDroppedDoc) {
        continue;
      }
      // Remap onto the output segment. apply_delete keeps the newer entry
      // when several inputs (or a pre-existing output state) cover the same
      // output doc, so stale generations never overwrite newer ones.
      out.apply_delete(gen, map[doc]);
    }
  }
  for (const SegmentId in : active.spec.inputs) {
    segments_.erase(in);
  }
  return active.spec.output;
}

void DeletionRegistry::abort_merge() {
  if (!merge_) {
    throw std::logic_error("dataeng: no active merge");
  }
  if (merge_->created_output) {
    segments_.erase(merge_->spec.output);
  }
  merge_.reset();
}

} // namespace dataeng

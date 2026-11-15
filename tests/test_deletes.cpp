#include "dataeng.hpp"

#include <cstdio>
#include <map>
#include <random>
#include <vector>

using namespace dataeng;

static int failures = 0;

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      ++failures;                                                            \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);   \
    }                                                                        \
  } while (0)

static void test_apply_and_visibility() {
  SegmentDeletes seg(7);
  CHECK(seg.segment_generation() == 7);
  CHECK(seg.delete_generation() == 0);

  CHECK(seg.apply_delete(3, 10));
  CHECK(seg.is_deleted(10));
  CHECK(!seg.is_deleted(11));
  CHECK(!seg.is_deleted(1000));
  CHECK(seg.delete_generation_of(10) == 3);
  CHECK(seg.delete_generation() == 3);
  CHECK(seg.deleted_count() == 1);

  // Visibility is per-document and snapshot-relative.
  CHECK(seg.is_visible_at(10, 2));
  CHECK(!seg.is_visible_at(10, 3));
  CHECK(!seg.is_visible_at(10, 100));
  CHECK(seg.is_visible_at(11, 100));
}

static void test_stale_receipts() {
  SegmentDeletes seg(1);
  CHECK(seg.apply_delete(5, 4));
  CHECK(!seg.apply_delete(5, 4)); // duplicate receipt
  CHECK(!seg.apply_delete(2, 4)); // old generation cannot overwrite
  CHECK(seg.delete_generation_of(4) == 5);
  CHECK(seg.is_visible_at(4, 4));
  CHECK(!seg.is_visible_at(4, 5));

  CHECK(seg.apply_delete(9, 4)); // newer receipt refreshes the entry
  CHECK(seg.delete_generation_of(4) == 9);
  CHECK(seg.delete_generation() == 9);
  CHECK(seg.is_visible_at(4, 8));
  CHECK(seg.deleted_count() == 1);
}

static void test_segment_generation_guard() {
  DeletionRegistry reg;
  reg.open_segment(1, 100);
  CHECK(reg.apply_delete(1, 100, 5, 4));
  CHECK(!reg.apply_delete(1, 99, 6, 5));  // stale segment generation
  CHECK(!reg.apply_delete(1, 101, 6, 5)); // future generation also rejected
  CHECK(!reg.apply_delete(2, 100, 6, 5)); // unknown segment
  CHECK(reg.find(1)->is_deleted(4));
  CHECK(!reg.find(1)->is_deleted(5));

  reg.open_segment(1, 101); // newer generation resets the bitset
  CHECK(reg.find(1)->segment_generation() == 101);
  CHECK(!reg.find(1)->is_deleted(4));
  CHECK(reg.find(1)->deleted_count() == 0);
  CHECK(!reg.apply_delete(1, 100, 7, 9)); // receipt for old generation
  CHECK(reg.apply_delete(1, 101, 7, 9));

  reg.open_segment(1, 101); // same generation is a no-op
  CHECK(reg.find(1)->is_deleted(9));
}

static void test_merge_carry_and_remap() {
  DeletionRegistry reg;
  reg.open_segment(1, 1);
  reg.open_segment(2, 1);
  // Deletes visible at snapshot 10.
  CHECK(reg.apply_delete(1, 1, 5, 0));
  CHECK(reg.apply_delete(1, 1, 8, 2));
  CHECK(reg.apply_delete(2, 1, 10, 1));

  MergeSpec spec;
  spec.inputs = {1, 2};
  spec.output = 3;
  spec.output_segment_gen = 50;
  // Segment 1: docs 0..3 -> output 0..3 (doc 3 dropped by the reader).
  // Segment 2: docs 0..2 -> output 4..6.
  spec.doc_maps = {{0, 1, 2, kDroppedDoc}, {4, 5, 6}};
  reg.begin_merge(spec, /*snapshot=*/10);
  CHECK(reg.merge_active());

  // New deletes during the merge are remapped onto the output segment.
  CHECK(reg.apply_delete(1, 1, 11, 1));
  CHECK(reg.apply_delete(2, 1, 12, 0));
  // Stale receipts during the merge are ignored.
  CHECK(!reg.apply_delete(1, 0, 13, 3));
  CHECK(!reg.apply_delete(1, 1, 4, 0));
  // Inputs of an active merge cannot be closed.
  CHECK(!reg.close_segment(1));

  const SegmentId out = reg.commit_merge();
  CHECK(out == 3);
  CHECK(!reg.merge_active());
  CHECK(!reg.has_segment(1));
  CHECK(!reg.has_segment(2));

  const SegmentDeletes* o = reg.find(3);
  CHECK(o != nullptr);
  CHECK(o->segment_generation() == 50);
  // Carried from the snapshot.
  CHECK(o->is_deleted(0) && o->delete_generation_of(0) == 5);
  CHECK(o->is_deleted(2) && o->delete_generation_of(2) == 8);
  CHECK(o->is_deleted(5) && o->delete_generation_of(5) == 10);
  // Remapped from deletes that arrived during the merge.
  CHECK(o->is_deleted(1) && o->delete_generation_of(1) == 11);
  CHECK(o->is_deleted(4) && o->delete_generation_of(4) == 12);
  // Dropped document carries nothing.
  CHECK(!o->is_deleted(3));
  CHECK(o->deleted_count() == 5);
  CHECK(o->delete_generation() == 12);

  // Old receipts cannot overwrite the merged bitset.
  CHECK(!reg.apply_delete(3, 49, 20, 0)); // stale segment generation
  CHECK(!reg.apply_delete(3, 50, 4, 0));  // stale delete generation
  CHECK(o->delete_generation_of(0) == 5);
  CHECK(reg.apply_delete(3, 50, 13, 0)); // newer receipt still lands
  CHECK(o->delete_generation_of(0) == 13);
}

static void test_merge_abort() {
  DeletionRegistry reg;
  reg.open_segment(5, 1);
  reg.open_segment(6, 1);
  CHECK(reg.apply_delete(5, 1, 3, 0));

  MergeSpec spec;
  spec.inputs = {5, 6};
  spec.output = 7;
  spec.output_segment_gen = 9;
  spec.doc_maps = {{0}, {0}};
  reg.begin_merge(spec, 3);
  CHECK(reg.apply_delete(6, 1, 4, 0)); // during-merge delete
  reg.abort_merge();

  CHECK(!reg.merge_active());
  CHECK(reg.has_segment(5));
  CHECK(reg.has_segment(6));
  CHECK(!reg.has_segment(7)); // output created by begin_merge is removed
  CHECK(reg.find(5)->is_deleted(0));
  CHECK(reg.find(6)->is_deleted(0)); // during-merge delete retained
}

// Reference model: independent implementation over ordered maps, tracking
// the same per-document delete generations.
struct RefModel {
  struct Seg {
    SegmentGen gen = 0;
    std::map<DocId, DeleteGen> del;
  };
  std::map<SegmentId, Seg> segs;

  void open(SegmentId id, SegmentGen gen) {
    auto it = segs.find(id);
    if (it == segs.end()) {
      segs[id] = Seg{gen, {}};
    } else if (gen > it->second.gen) {
      it->second = Seg{gen, {}};
    }
  }

  bool close(SegmentId id) { return segs.erase(id) != 0; }

  bool apply(SegmentId id, SegmentGen seg_gen, DeleteGen del_gen, DocId doc) {
    auto it = segs.find(id);
    if (it == segs.end() || it->second.gen != seg_gen) {
      return false;
    }
    DeleteGen& cur = it->second.del[doc];
    if (del_gen <= cur) {
      return false;
    }
    cur = del_gen;
    return true;
  }

  void commit_merge(const MergeSpec& spec) {
    open(spec.output, spec.output_segment_gen);
    Seg& out = segs[spec.output];
    for (std::size_t i = 0; i < spec.inputs.size(); ++i) {
      const Seg& in = segs.at(spec.inputs[i]);
      const std::vector<DocId>& map = spec.doc_maps[i];
      for (const auto& kv : in.del) {
        if (kv.first >= map.size() || map[kv.first] == kDroppedDoc) {
          continue;
        }
        DeleteGen& cur = out.del[map[kv.first]];
        cur = std::max(cur, kv.second);
      }
    }
    for (const SegmentId in : spec.inputs) {
      segs.erase(in);
    }
  }
};

static void test_randomized_against_model() {
  std::mt19937_64 rng(0x5eedu);
  DeletionRegistry reg;
  RefModel model;
  std::map<SegmentId, SegmentGen> known_gens;
  DeleteGen next_gen = 1;

  auto rand_seg = [&]() { return static_cast<SegmentId>(rng() % 6); };
  auto rand_doc = [&]() { return static_cast<DocId>(rng() % 64); };

  for (int step = 0; step < 20000; ++step) {
    const int op = static_cast<int>(rng() % 100);
    if (op < 10) {
      // Open or re-generate a segment.
      const SegmentId id = rand_seg();
      const SegmentGen gen = known_gens[id] + (rng() % 2);
      reg.open_segment(id, gen);
      model.open(id, gen);
      known_gens[id] = std::max(known_gens[id], gen);
    } else if (op < 55) {
      // Apply a delete receipt, sometimes with stale generations.
      const SegmentId id = rand_seg();
      SegmentGen seg_gen = known_gens[id];
      if (seg_gen > 1 && rng() % 4 == 0) {
        --seg_gen; // stale segment-generation receipt
      }
      DeleteGen del_gen;
      if (rng() % 4 == 0 && next_gen > 1) {
        del_gen = 1 + rng() % next_gen; // possibly stale delete generation
      } else {
        del_gen = next_gen++;
      }
      const DocId doc = rand_doc();
      CHECK(reg.apply_delete(id, seg_gen, del_gen, doc) ==
            model.apply(id, seg_gen, del_gen, doc));
    } else if (op < 60 && !reg.merge_active()) {
      const SegmentId id = rand_seg();
      if (reg.has_segment(id)) {
        CHECK(reg.close_segment(id) == model.close(id));
        if (!reg.has_segment(id)) {
          known_gens.erase(id);
        }
      }
    } else if (op < 70 && !reg.merge_active()) {
      // Begin a merge over up to 3 existing segments.
      std::vector<SegmentId> inputs;
      for (const auto& kv : model.segs) {
        if (inputs.size() < 3 && rng() % 2) {
          inputs.push_back(kv.first);
        }
      }
      if (inputs.empty()) {
        continue;
      }
      MergeSpec spec;
      spec.inputs = inputs;
      spec.output = 100 + static_cast<SegmentId>(rng() % 3);
      spec.output_segment_gen = known_gens[spec.output] + 1 + rng() % 3;
      bool collision = false;
      for (const SegmentId in : inputs) {
        collision = collision || in == spec.output;
      }
      if (collision) {
        continue;
      }
      for (const SegmentId in : inputs) {
        const SegmentDeletes* s = reg.find(in);
        std::vector<DocId> map(s ? s->doc_capacity() : 0);
        DocId next_out = static_cast<DocId>(rng() % 4);
        for (DocId& m : map) {
          if (rng() % 8 == 0) {
            m = kDroppedDoc;
          } else {
            m = next_out++;
          }
        }
        spec.doc_maps.push_back(std::move(map));
      }
      const DeleteGen snapshot = next_gen > 1 ? rng() % next_gen : 0;
      const bool output_preexisted = model.segs.count(spec.output) != 0;
      reg.begin_merge(spec, snapshot);
      // begin_merge opens (and possibly re-generates) the output segment.
      model.open(spec.output, spec.output_segment_gen);
      known_gens[spec.output] =
          std::max(known_gens[spec.output], spec.output_segment_gen);
      if (rng() % 5 == 0) {
        reg.abort_merge();
        if (!output_preexisted) {
          // abort_merge drops an output segment created by begin_merge.
          model.segs.erase(spec.output);
          known_gens.erase(spec.output);
        }
      } else {
        reg.commit_merge();
        model.commit_merge(spec);
        for (const SegmentId in : inputs) {
          known_gens.erase(in);
        }
      }
    } else if (op < 75 && reg.merge_active()) {
      reg.abort_merge();
    }

    // Spot-check per-document visibility against the reference model.
    for (int q = 0; q < 8; ++q) {
      const SegmentId id = rand_seg();
      const DocId doc = rand_doc();
      const DeleteGen snapshot = rng() % (next_gen + 2);
      const SegmentDeletes* s = reg.find(id);
      const auto it = model.segs.find(id);
      CHECK((s != nullptr) == (it != model.segs.end()));
      if (!s) {
        continue;
      }
      CHECK(s->segment_generation() == it->second.gen);
      const auto dit = it->second.del.find(doc);
      const DeleteGen want = dit == it->second.del.end() ? 0 : dit->second;
      CHECK(s->delete_generation_of(doc) == want);
      CHECK(s->is_deleted(doc) == (want != 0));
      CHECK(s->is_visible_at(doc, snapshot) == (want == 0 || want > snapshot));
    }
  }

  // Final exhaustive comparison.
  for (const auto& kv : model.segs) {
    const SegmentDeletes* s = reg.find(kv.first);
    CHECK(s != nullptr);
    if (!s) {
      continue;
    }
    CHECK(s->segment_generation() == kv.second.gen);
    std::size_t want_count = 0;
    DeleteGen want_max = 0;
    for (DocId doc = 0; doc < 80; ++doc) {
      const auto it = kv.second.del.find(doc);
      const DeleteGen want = it == kv.second.del.end() ? 0 : it->second;
      CHECK(s->delete_generation_of(doc) == want);
      CHECK(s->is_deleted(doc) == (want != 0));
      if (want != 0) {
        ++want_count;
        want_max = std::max(want_max, want);
      }
    }
    CHECK(s->deleted_count() == want_count);
    CHECK(s->delete_generation() == want_max);
  }
}

int main() {
  test_apply_and_visibility();
  test_stale_receipts();
  test_segment_generation_guard();
  test_merge_carry_and_remap();
  test_merge_abort();
  test_randomized_against_model();

  if (failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", failures);
    return 1;
  }
  std::puts("all tests passed");
  return 0;
}

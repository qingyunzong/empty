#include "dlks_formal.hpp"
#include "model.hpp"
#include "test_framework.hpp"

#include <cstddef>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

using Store = dlks_formal::SegmentStore<int, int>;
using Model = dlks_test::NaiveModel<int, int>;

struct Action {
  enum class Kind { Put, Erase, Begin, AutoBegin, Step, Run };

  Kind kind = Kind::Put;
  int key = 0;
  int value = 0;
  std::size_t bytes = 0;
  std::uint32_t segment = Store::no_segment;

  std::string name() const {
    std::ostringstream out;
    switch (kind) {
      case Kind::Put:
        out << "put(" << key << ',' << value << ',' << bytes << ')';
        break;
      case Kind::Erase:
        out << "erase(" << key << ',' << bytes << ')';
        break;
      case Kind::Begin:
        out << "begin(" << segment << ')';
        break;
      case Kind::AutoBegin:
        out << "begin_auto";
        break;
      case Kind::Step:
        out << "step";
        break;
      case Kind::Run:
        out << "run";
        break;
    }
    return out.str();
  }
};

bool apply_action(Store& store, Model& model, const Action& action) {
  switch (action.kind) {
    case Action::Kind::Put:
      if (!store.put(action.key, action.value, action.bytes)) {
        return false;
      }
      model.put(action.key, action.value);
      return true;
    case Action::Kind::Erase:
      if (!store.erase(action.key, action.bytes)) {
        return false;
      }
      model.erase(action.key);
      return true;
    case Action::Kind::Begin:
      return store.begin_clean(action.segment);
    case Action::Kind::AutoBegin:
      return store.begin_clean();
    case Action::Kind::Step: {
      const auto result = store.clean_step();
      CHECK(result != dlks_formal::CleanStepResult::NoSpace);
      return result == dlks_formal::CleanStepResult::Copied ||
             result == dlks_formal::CleanStepResult::Skipped ||
             result == dlks_formal::CleanStepResult::Finished;
    }
    case Action::Kind::Run:
      if (!store.cleaning_active()) {
        return false;
      }
      CHECK(store.run_clean());
      return true;
  }
  return false;
}

struct CleanBaseline {
  std::size_t used_bytes = 0;
  std::size_t free_bytes = 0;
  std::uint64_t reclaimed_bytes = 0;
  std::size_t appended_bytes = 0;
};

void check_immediate_conservation(const dlks_formal::StoreStats& before,
                                  const dlks_formal::StoreStats& after) {
  CHECK(after.free_bytes >= before.free_bytes);
  CHECK(after.reclaimed_bytes >= before.reclaimed_bytes);
  const std::uint64_t reclaimed =
      after.reclaimed_bytes - before.reclaimed_bytes;
  CHECK_EQ(after.free_bytes - before.free_bytes, reclaimed);
  CHECK_EQ(after.used_bytes + reclaimed, before.used_bytes);
}

void check_session_conservation(const CleanBaseline& baseline,
                                const dlks_formal::StoreStats& after) {
  CHECK(after.reclaimed_bytes >= baseline.reclaimed_bytes);
  const std::uint64_t reclaimed =
      after.reclaimed_bytes - baseline.reclaimed_bytes;
  CHECK_EQ(after.used_bytes + reclaimed,
           baseline.used_bytes + baseline.appended_bytes);
  CHECK_EQ(after.free_bytes + baseline.appended_bytes,
           baseline.free_bytes + reclaimed);
}

std::optional<CleanBaseline> account_action(
    const Action& action, const dlks_formal::StoreStats& before,
    const dlks_formal::StoreStats& after,
    std::optional<CleanBaseline> baseline) {
  switch (action.kind) {
    case Action::Kind::Put:
    case Action::Kind::Erase:
      CHECK_EQ(after.used_bytes, before.used_bytes + action.bytes);
      CHECK_EQ(after.free_bytes + action.bytes, before.free_bytes);
      CHECK_EQ(after.version, before.version + 1);
      CHECK_EQ(after.reclaimed_bytes, before.reclaimed_bytes);
      if (baseline.has_value()) {
        baseline->appended_bytes += action.bytes;
      }
      break;
    case Action::Kind::Begin:
    case Action::Kind::AutoBegin:
      if (!before.cleaning_active && after.cleaning_active) {
        baseline = CleanBaseline{before.used_bytes, before.free_bytes,
                                 before.reclaimed_bytes, 0};
      } else if (!before.cleaning_active && !after.cleaning_active) {
        check_immediate_conservation(before, after);
      }
      break;
    case Action::Kind::Step:
    case Action::Kind::Run:
      if (before.cleaning_active && after.cleaning_active) {
        CHECK(baseline.has_value());
        CHECK_EQ(after.reclaimed_bytes, baseline->reclaimed_bytes);
      } else if (before.cleaning_active && !after.cleaning_active) {
        CHECK(baseline.has_value());
        check_session_conservation(*baseline, after);
        baseline.reset();
      }
      break;
  }
  return baseline;
}

struct Config {
  std::size_t segment_count = 2;
  std::size_t segment_capacity = 4;
  std::vector<int> keys = {0, 1};
  std::vector<int> values = {0, 1};
  int depth = 5;
  bool auto_begin = true;
};

std::size_t footprint_for(int key, int value) {
  return 1 + static_cast<std::size_t>((key + value) & 1);
}

class Explorer {
 public:
  explicit Explorer(Config config) : config_(std::move(config)) {}

  std::uint64_t run() {
    Store store(dlks_formal::SegmentStoreConfig{config_.segment_capacity,
                                                config_.segment_count});
    Model model;
    explore(store, model, 0, std::nullopt);
    return nodes_;
  }

 private:
  std::vector<Action> actions_for(const Store& store) const {
    std::vector<Action> actions;
    for (const int key : config_.keys) {
      for (const int value : config_.values) {
        actions.push_back(Action{Action::Kind::Put, key, value,
                                 footprint_for(key, value),
                                 Store::no_segment});
      }
      actions.push_back(
          Action{Action::Kind::Erase, key, 0, 1, Store::no_segment});
    }

    const auto stats = store.stats();
    if (stats.cleaning_active) {
      actions.push_back(
          Action{Action::Kind::Step, 0, 0, 0, Store::no_segment});
      actions.push_back(
          Action{Action::Kind::Run, 0, 0, 0, Store::no_segment});
      return actions;
    }

    bool any_dirty = false;
    for (const auto& segment : stats.segments) {
      if (segment.state == dlks_formal::SegmentState::Free) {
        continue;
      }
      if (segment.dead_bytes > 0 || segment.used_bytes == 0) {
        actions.push_back(
            Action{Action::Kind::Begin, 0, 0, 0, segment.id});
        any_dirty = true;
      }
    }
    if (any_dirty && config_.auto_begin) {
      actions.push_back(
          Action{Action::Kind::AutoBegin, 0, 0, 0, Store::no_segment});
    }
    return actions;
  }

  std::string path_string() const {
    std::ostringstream out;
    for (const Action& action : path_) {
      out << action.name() << " | ";
    }
    return out.str();
  }

  void explore(const Store& store, const Model& model, int depth,
               std::optional<CleanBaseline> baseline) {
    try {
      dlks_test::verify_store_against_model(store, model, path_string());
    } catch (const std::exception& error) {
      throw dlks_test::Failure(path_string() + " :: " + error.what());
    }
    ++nodes_;
    if (depth >= config_.depth) {
      return;
    }
    const auto before = store.stats();
    for (const Action& action : actions_for(store)) {
      Store child = store;
      Model child_model = model;
      if (!apply_action(child, child_model, action)) {
        continue;
      }
      std::optional<CleanBaseline> child_baseline;
      try {
        child_baseline =
            account_action(action, before, child.stats(), baseline);
      } catch (const std::exception& error) {
        std::ostringstream out;
        out << path_string() << action.name() << " :: before used="
            << before.used_bytes << " free=" << before.free_bytes
            << " reclaimed=" << before.reclaimed_bytes << " after used="
            << child.stats().used_bytes << " free=" << child.stats().free_bytes
            << " reclaimed=" << child.stats().reclaimed_bytes;
        throw dlks_test::Failure(out.str() + " :: " + error.what());
      }
      path_.push_back(action);
      explore(child, child_model, depth + 1, child_baseline);
      path_.pop_back();
    }
  }

  Config config_;
  std::vector<Action> path_;
  std::uint64_t nodes_ = 0;
};

void run_config(const Config& config) {
  Explorer explorer(config);
  const std::uint64_t nodes = explorer.run();
  CHECK(nodes > 0);
  std::cout << "       explored " << nodes << " states (" << config.segment_count
            << "x" << config.segment_capacity << ", depth " << config.depth
            << ")\n";
}

}  // namespace

DLKS_TEST(exhaustive_two_segment_small_space) {
  run_config(Config{2, 4, {0, 1}, {0, 1}, 7, true});
}

DLKS_TEST(exhaustive_three_segment_relocation_space) {
  run_config(Config{3, 5, {0, 1}, {0, 1}, 6, true});
}

DLKS_TEST(exhaustive_three_segments_three_keys) {
  run_config(Config{3, 6, {0, 1, 2}, {0, 1}, 5, false});
}

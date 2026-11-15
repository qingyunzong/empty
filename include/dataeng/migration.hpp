#pragma once

#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "dataeng/descriptor.hpp"
#include "dataeng/status.hpp"

// Schema migration planning.
//
// A MigrationPlan is a validated, executable description of how a message
// encoded under the old descriptor is rewritten under the new one. Building
// the plan performs every *static* safety check so that Transform() never has
// to reject data at runtime for schema reasons:
//
//   * field number reuse with an incompatible wire type is rejected,
//   * two source fields targeting the same destination number are rejected,
//   * reuse of reserved numbers is rejected,
//   * every other change is allowed but recorded as an irreversible change
//     or an informational note on the MigrationReport.
namespace dataeng {

enum class Severity {
  kInfo,          // representation change, round-trip safe
  kIrreversible,  // data/semantics cannot be fully recovered
};

struct Change {
  Severity severity = Severity::kInfo;
  std::string code;
  std::string detail;
};

struct FieldMapping {
  int src_number = 0;
  int dst_number = 0;
  // When true the source field is intentionally discarded rather than mapped.
  // Drops are always reported as irreversible; dst_number is ignored.
  bool drop = false;
};

struct MessageMigration {
  const MessageDescriptor* src = nullptr;
  const MessageDescriptor* dst = nullptr;
  // Explicit renames/relocations. src_number -> dst_number.
  std::vector<FieldMapping> mappings;
  // When true, every unmapped source field whose number still exists on the
  // destination with a wire-compatible type is forwarded automatically.
  bool auto_passthrough = true;
};

class MigrationPlan;

class MigrationReport {
 public:
  const std::vector<Change>& changes() const { return changes_; }
  bool has_irreversible() const {
    for (const auto& c : changes_) {
      if (c.severity == Severity::kIrreversible) return true;
    }
    return false;
  }

  void Add(Severity severity, std::string code, std::string detail) {
    changes_.push_back(Change{severity, std::move(code), std::move(detail)});
  }

 private:
  std::vector<Change> changes_;
};

// One resolved, runtime-ready mapping. `dropped` mappings carry no
// destination and cause source occurrences to be discarded (irreversible).
struct ResolvedMapping {
  int src_number = 0;
  std::optional<int> dst_number;
  bool dropped = false;
};

class MigrationPlan {
 public:
  static Status Build(const MessageMigration& spec,
                      std::unique_ptr<MigrationPlan>& plan);

  // Invert a plan (new descriptor -> old descriptor). The reverse plan keeps
  // the same validated field number pairs; irreversible changes stay recorded
  // on the report so callers can see what a round trip cannot restore.
  static Status BuildReverse(const MigrationPlan& forward,
                             std::unique_ptr<MigrationPlan>& reverse);

  const MessageDescriptor& src() const { return *src_; }
  const MessageDescriptor& dst() const { return *dst_; }
  const MigrationReport& report() const { return report_; }
  // Runtime transforms may append observations (e.g. oneof collisions) even
  // while holding a const plan; the report is intentionally mutable.
  MigrationReport& mutable_report() const { return report_; }

  // Resolved mapping keyed by source field number.
  const std::unordered_map<int, ResolvedMapping>& by_src() const {
    return by_src_;
  }
  // Reverse lookup keyed by destination field number.
  const std::unordered_map<int, int>& dst_to_src() const {
    return dst_to_src_;
  }

  // Nested message plans keyed by destination message full name. The
  // transformer recurses into mapped length-delimited message fields.
  const std::unordered_map<std::string, const MigrationPlan*>& nested() const {
    return nested_;
  }
  void AddNested(const std::string& type_name, const MigrationPlan* plan) {
    nested_[type_name] = plan;
  }

 private:
  MigrationPlan() = default;

  const MessageDescriptor* src_ = nullptr;
  const MessageDescriptor* dst_ = nullptr;
  mutable MigrationReport report_;
  std::unordered_map<int, ResolvedMapping> by_src_;
  std::unordered_map<int, int> dst_to_src_;
  std::unordered_map<std::string, const MigrationPlan*> nested_;

  friend struct PlanBuilder;
};

}  // namespace dataeng

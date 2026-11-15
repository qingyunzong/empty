#include "dataeng/migration.hpp"

#include <algorithm>
#include <set>
#include <sstream>

namespace dataeng {

namespace {

std::string FieldLabel(const FieldDescriptor& f) {
  std::ostringstream os;
  os << "#" << f.number << " '" << f.name << "'";
  return os.str();
}

bool IsReserved(const MessageDescriptor& msg, int number) {
  for (int r : msg.reserved_numbers) {
    if (r == number) return true;
  }
  return false;
}

bool InExtensionRange(const MessageDescriptor& msg, int number) {
  for (const auto& range : msg.extension_ranges) {
    if (number >= range.start && number < range.end) return true;
  }
  return false;
}

}  // namespace

struct PlanBuilder {
  static Status Run(const MessageMigration& spec, MigrationPlan& plan) {
    if (spec.src == nullptr || spec.dst == nullptr) {
      return Status::Error(StatusCode::kInvalidArgument,
                           "MessageMigration requires src and dst descriptors");
    }
    plan.src_ = spec.src;
    plan.dst_ = spec.dst;
    auto& report = plan.report_;

    // --- 1. structural descriptor sanity -----------------------------------
    std::set<int> src_numbers;
    for (const auto& f : spec.src->fields) {
      if (f.number <= 0) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "source field numbers must be positive: " + f.name);
      }
      if (!src_numbers.insert(f.number).second) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "duplicate source field number " +
                                 std::to_string(f.number));
      }
    }
    std::set<int> dst_numbers;
    for (const auto& f : spec.dst->fields) {
      if (f.number <= 0) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "destination field numbers must be positive: " +
                                 f.name);
      }
      if (!dst_numbers.insert(f.number).second) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "duplicate destination field number " +
                                 std::to_string(f.number));
      }
    }

    // --- 2. explicit mappings ----------------------------------------------
    std::set<int> explicit_src;
    std::set<int> claimed_dst;
    for (const auto& m : spec.mappings) {
      if (!explicit_src.insert(m.src_number).second) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "duplicate mapping for source field " +
                                 std::to_string(m.src_number));
      }
      const FieldDescriptor* sf = spec.src->FindByNumber(m.src_number);
      if (sf == nullptr) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "no source field with number " +
                                 std::to_string(m.src_number));
      }
      if (m.drop) {
        plan.by_src_[sf->number] =
            ResolvedMapping{sf->number, std::nullopt, true};
        report.Add(Severity::kIrreversible, "FIELD_DROPPED",
                   FieldLabel(*sf) +
                       " is explicitly dropped; values cannot be recovered "
                       "by a reverse migration");
        continue;
      }
      if (m.dst_number <= 0) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "destination field numbers must be positive");
      }
      if (!claimed_dst.insert(m.dst_number).second) {
        return Status::Error(
            StatusCode::kFieldNumberReuse,
            "field number reuse: multiple source fields map to destination " +
                std::to_string(m.dst_number));
      }
      const FieldDescriptor* df = spec.dst->FindByNumber(m.dst_number);
      if (df == nullptr) {
        return Status::Error(StatusCode::kInvalidArgument,
                             "no destination field with number " +
                                 std::to_string(m.dst_number));
      }
      if (IsReserved(*spec.dst, m.dst_number)) {
        return Status::Error(StatusCode::kFieldNumberReuse,
                             "destination number " +
                                 std::to_string(m.dst_number) + " is reserved");
      }

      if (WireTypeFor(sf->kind) != WireTypeFor(df->kind)) {
        return Status::Error(
            StatusCode::kWireTypeConflict,
            "wire type conflict for " + FieldLabel(*sf) + " -> " +
                FieldLabel(*df) + ": incompatible wire representations");
      }
      if ((sf->label == Label::kRepeated) !=
          (df->label == Label::kRepeated)) {
        return Status::Error(
            StatusCode::kWireTypeConflict,
            "cardinality conflict for " + FieldLabel(*sf) + " -> " +
                FieldLabel(*df) + ": repeated vs singular");
      }

      plan.by_src_[sf->number] =
          ResolvedMapping{sf->number, df->number, false};
      plan.dst_to_src_[df->number] = sf->number;

      RecordFieldChanges(*sf, *df, report);
      RecordOneofChanges(*sf, *df, spec, report);
    }

    // --- 3. automatic passthrough for remaining fields ---------------------
    for (const auto& sf : spec.src->fields) {
      if (explicit_src.count(sf.number) != 0) continue;
      const FieldDescriptor* df = spec.dst->FindByNumber(sf.number);
      if (df == nullptr) {
        if (spec.auto_passthrough) {
          report.Add(Severity::kInfo, "FIELD_REMOVED",
                     FieldLabel(sf) +
                         " absent on destination; preserved as unknown field");
        }
        continue;
      }

      if (IsReserved(*spec.dst, sf.number)) {
        return Status::Error(
            StatusCode::kFieldNumberReuse,
            "field number " + std::to_string(sf.number) +
                " is reserved on the destination");
      }
      if (claimed_dst.count(sf.number) != 0) {
        return Status::Error(
            StatusCode::kFieldNumberReuse,
            "field number reuse at destination number " +
                std::to_string(sf.number) +
                ": explicit mapping collides with existing field");
      }

      if (WireTypeFor(sf.kind) != WireTypeFor(df->kind)) {
        return Status::Error(
            StatusCode::kWireTypeConflict,
            "wire type conflict at reused field number " +
                std::to_string(sf.number) + ": " + FieldLabel(sf) + " vs " +
                FieldLabel(*df));
      }
      if ((sf.label == Label::kRepeated) !=
          (df->label == Label::kRepeated)) {
        return Status::Error(StatusCode::kWireTypeConflict,
                             "cardinality conflict at field number " +
                                 std::to_string(sf.number));
      }

      if (spec.auto_passthrough) {
        plan.by_src_[sf.number] =
            ResolvedMapping{sf.number, df->number, false};
        plan.dst_to_src_[df->number] = sf.number;
        claimed_dst.insert(sf.number);
        RecordFieldChanges(sf, *df, report);
        RecordOneofChanges(sf, *df, spec, report);
      }
    }

    // --- 4. new destination fields & required-field coverage ---------------
    for (const auto& df : spec.dst->fields) {
      if (plan.dst_to_src_.count(df.number) != 0) continue;
      if (InExtensionRange(*spec.dst, df.number) || df.extension) continue;
      report.Add(Severity::kInfo, "FIELD_ADDED",
                 FieldLabel(df) +
                     " has no source counterpart; left at default value");
      if (df.label == Label::kRequired) {
        report.Add(Severity::kIrreversible, "REQUIRED_FIELD_UNSATISFIED",
                   "required destination " + FieldLabel(df) +
                       " cannot be populated from the source schema");
      }
    }

    // --- 5. extension stability --------------------------------------------
    for (const auto& sf : spec.src->fields) {
      if (!sf.extension && !InExtensionRange(*spec.src, sf.number)) continue;
      if (const FieldDescriptor* df =
              spec.dst->FindByNumber(sf.number);
          df != nullptr && !df->extension &&
          !InExtensionRange(*spec.dst, df->number)) {
        report.Add(Severity::kIrreversible, "EXTENSION_NOW_DECLARED",
                   "extension number " + std::to_string(sf.number) +
                       " became a regular field");
      }
    }

    return Status::Ok();
  }

  static void RecordFieldChanges(const FieldDescriptor& sf,
                                 const FieldDescriptor& df,
                                 MigrationReport& report) {
    if (sf.kind != df.kind &&
        WireTypeFor(sf.kind) == WireTypeFor(df.kind)) {
      report.Add(Severity::kIrreversible, "KIND_CHANGED",
                 FieldLabel(sf) + " retyped to " + FieldLabel(df) +
                     " (same wire type; value semantics may differ)");
    }
    if (sf.packed != df.packed) {
      report.Add(Severity::kInfo, "PACKED_CHANGED",
                 FieldLabel(sf) + " packed flag " +
                     (df.packed ? "enabled" : "disabled") +
                     " on destination (wire-level reversible)");
    }
    if (sf.label != df.label) {
      bool lost_presence =
          HasExplicitPresence(sf) && !HasExplicitPresence(df);
      report.Add(lost_presence ? Severity::kIrreversible : Severity::kInfo,
                 lost_presence ? "PRESENCE_LOST" : "LABEL_CHANGED",
                 FieldLabel(sf) + " label changed to " + FieldLabel(df));
    }
    if (sf.name != df.name) {
      report.Add(Severity::kInfo, "FIELD_RENAMED",
                 FieldLabel(sf) + " renamed to '" + df.name + "'");
    }
  }

  static void RecordOneofChanges(const FieldDescriptor& sf,
                                 const FieldDescriptor& df,
                                 const MessageMigration& spec,
                                 MigrationReport& report) {
    if (sf.oneof_name == df.oneof_name) return;

    if (df.oneof_name.empty()) {
      report.Add(Severity::kInfo, "ONEOF_MEMBERSHIP_LEFT",
                 FieldLabel(sf) + " leaves oneof '" + sf.oneof_name + "'");
      return;
    }
    if (sf.oneof_name.empty()) {
      report.Add(Severity::kInfo, "ONEOF_MEMBERSHIP_JOINED",
                 FieldLabel(sf) + " joins oneof '" + df.oneof_name + "'");
      return;
    }

    // Moving between two distinct oneofs. Detect a merge: if another source
    // oneof also contributes a member to the same destination oneof, runtime
    // messages carrying both members would collapse to a single choice.
    for (const auto& other : spec.src->fields) {
      if (other.number == sf.number ||
          other.oneof_name == sf.oneof_name ||
          other.oneof_name.empty()) {
        continue;
      }
      const FieldDescriptor* other_dst = nullptr;
      if (const auto it = std::find_if(
              spec.mappings.begin(), spec.mappings.end(),
              [&](const FieldMapping& m) {
                return m.src_number == other.number;
              });
          it != spec.mappings.end()) {
        other_dst = spec.dst->FindByNumber(it->dst_number);
      } else {
        other_dst = spec.dst->FindByNumber(other.number);
      }
      if (other_dst != nullptr &&
          other_dst->oneof_name == df.oneof_name) {
        report.Add(
            Severity::kIrreversible, "ONEOF_MERGE",
            "oneofs '" + sf.oneof_name + "' and '" + other.oneof_name +
                "' merge into '" + df.oneof_name +
                "'; simultaneous selections cannot round-trip");
        return;
      }
    }
    report.Add(Severity::kInfo, "ONEOF_MOVED",
               FieldLabel(sf) + " moves from oneof '" + sf.oneof_name +
                   "' to '" + df.oneof_name + "'");
  }
};

Status MigrationPlan::Build(const MessageMigration& spec,
                            std::unique_ptr<MigrationPlan>& plan) {
  plan.reset(new MigrationPlan());
  return PlanBuilder::Run(spec, *plan);
}

Status MigrationPlan::BuildReverse(const MigrationPlan& forward,
                                   std::unique_ptr<MigrationPlan>& reverse) {
  reverse.reset(new MigrationPlan());
  reverse->src_ = forward.dst_;
  reverse->dst_ = forward.src_;
  reverse->report_ = forward.report_;
  for (const auto& [src_number, m] : forward.by_src_) {
    if (!m.dst_number.has_value()) continue;
    reverse->by_src_[*m.dst_number] =
        ResolvedMapping{*m.dst_number, src_number, false};
    reverse->dst_to_src_[src_number] = *m.dst_number;
  }
  return Status::Ok();
}

}  // namespace dataeng

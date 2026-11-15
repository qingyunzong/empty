#include "dataeng/transform.hpp"

#include <unordered_set>

#include "dataeng/wire.hpp"

namespace dataeng {

namespace {

// Tracks oneof selections already emitted into this message. A second member
// of the same destination oneof would violate the oneof contract: protobuf
// parsing resolves it as last-writer-wins, which silently destroys the earlier
// selection. We count and report it instead of hiding it.
class OneofGuard {
 public:
  // Returns false when `dst_field` collides with an earlier selection.
  bool Observe(const MessageDescriptor& dst, int dst_number) {
    const FieldDescriptor* f = dst.FindByNumber(dst_number);
    if (f == nullptr || f->oneof_name.empty()) return true;
    return seen_oneofs_.insert(f->oneof_name).second;
  }

 private:
  std::unordered_set<std::string> seen_oneofs_;
};

Status RunMessage(const MigrationPlan& plan, std::string_view src,
                  std::string& dst, TransformStats& stats) {
  std::vector<wire::RawField> fields;
  if (Status s = wire::ParseMessage(src, fields); !s.ok()) return s;

  OneofGuard oneof_guard;
  dst.clear();
  dst.reserve(src.size());

  for (const wire::RawField& field : fields) {
    const auto mapping_it = plan.by_src().find(field.number);

    if (mapping_it != plan.by_src().end() && mapping_it->second.dropped) {
      // Explicitly dropped mapping: the field is intentionally removed.
      ++stats.dropped_fields;
      continue;
    }

    if (mapping_it == plan.by_src().end() ||
        !mapping_it->second.dst_number.has_value()) {
      // Unknown / removed field: preserve the original bytes (and therefore
      // the original field number) untouched. On the destination side these
      // are ordinary unknown fields, including orphaned extension numbers.
      wire::EmitField(dst, field, field.number);
      ++stats.unknown_fields_preserved;
      continue;
    }

    const int dst_number = *mapping_it->second.dst_number;
    const FieldDescriptor* src_field =
        plan.src().FindByNumber(field.number);
    const FieldDescriptor* dst_field =
        plan.dst().FindByNumber(dst_number);
    if (src_field == nullptr || dst_field == nullptr) {
      return Status::Error(StatusCode::kInvalidArgument,
                           "plan references a field missing from its "
                           "descriptor (descriptor lifetime issue)");
    }

    // A packed repeated scalar arrives as one length-delimited entry even
    // though the scalar's canonical wire type is varint/fixed. Unpacked
    // occurrences use the scalar's own wire type. Both are legal; anything
    // else means the encoded data contradicts the descriptor.
    bool packed_encoding =
        src_field->label == Label::kRepeated &&
        field.wire == wire::WireType::kLengthDelimited &&
        WireTypeFor(src_field->kind) != wire::WireType::kLengthDelimited;
    bool unpacked_encoding = field.wire == WireTypeFor(src_field->kind);
    if (!packed_encoding && !unpacked_encoding) {
      return Status::Error(
          StatusCode::kWireTypeConflict,
          "wire type conflict at runtime for source field " +
              std::to_string(field.number) +
              ": descriptor does not match encoded data");
    }

    if (!oneof_guard.Observe(plan.dst(), dst_number)) {
      ++stats.oneof_collisions;
      plan.mutable_report().Add(
          Severity::kIrreversible, "ONEOF_RUNTIME_COLLISION",
          "multiple members of destination oneof '" +
              dst_field->oneof_name +
              "' present in source message; last-writer-wins loses data");
    }

    // Recurse into nested messages when a sub-plan is registered. Both
    // packed and unpacked scalar payloads are simply copied, so no other
    // length-delimited kind needs interpretation.
    if (src_field->kind == ValueKind::kMessage) {
      const auto nested_it = plan.nested().find(dst_field->type_name);
      if (nested_it != plan.nested().end()) {
        std::string transformed_inner;
        if (Status s = RunMessage(*nested_it->second, field.payload,
                                  transformed_inner, stats);
            !s.ok()) {
          return s;
        }
        ++stats.nested_messages;
        wire::AppendTag(dst, dst_number,
                        wire::WireType::kLengthDelimited);
        wire::AppendLengthDelimited(dst, transformed_inner);
        ++stats.mapped_fields;
        continue;
      }
    }

    wire::EmitField(dst, field, dst_number);
    ++stats.mapped_fields;
  }

  return Status::Ok();
}

}  // namespace

Status Transform(const MigrationPlan& plan, std::string_view src,
                 std::string& dst, TransformStats& stats) {
  stats = TransformStats{};
  return RunMessage(plan, src, dst, stats);
}

Status Transform(const MigrationPlan& plan, std::string_view src,
                 std::string& dst) {
  TransformStats stats;
  return Transform(plan, src, dst, stats);
}

}  // namespace dataeng

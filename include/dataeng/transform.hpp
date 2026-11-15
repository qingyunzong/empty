#pragma once

#include <string>

#include "dataeng/migration.hpp"
#include "dataeng/status.hpp"

// Runtime message transformation.
//
// The transformer works one wire field at a time:
//
//   * a field that the plan maps is re-emitted under the destination number,
//     preserving its raw payload (and therefore presence, oneof selection and
//     scalar/extension encoding) byte-for-byte,
//   * a field that the plan knows nothing about is copied verbatim with its
//     original number. On the destination message these become standard
//     protobuf unknown fields, including extension numbers outside the new
//     extension ranges,
//   * nested message fields with registered sub-plans are transformed
//     recursively.
//
// Because untouched bytes are never decoded into values, a forward+backward
// round trip on an unmapped/unknown field reproduces the original bytes
// exactly.
namespace dataeng {

struct TransformStats {
  size_t mapped_fields = 0;
  size_t unknown_fields_preserved = 0;
  size_t dropped_fields = 0;
  size_t nested_messages = 0;
  size_t oneof_collisions = 0;
};

// Apply `plan` to a serialized source message. `dst` is overwritten.
Status Transform(const MigrationPlan& plan, std::string_view src,
                 std::string& dst, TransformStats& stats);

// Convenience overload when callers do not need statistics.
Status Transform(const MigrationPlan& plan, std::string_view src,
                 std::string& dst);

}  // namespace dataeng

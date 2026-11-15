#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "dataeng/wire.hpp"

// Lightweight descriptor model.
//
// It mirrors the subset of DescriptorProto needed for migration validation
// without depending on libprotobuf. Descriptors can be hand-built, populated
// from a descriptor pool, or generated from .proto files by an adapter.
namespace dataeng {

enum class Label {
  kOptional,   // proto2 optional or proto3 explicit optional (has-bit)
  kRequired,   // proto2 required
  kRepeated,   // unpacked or packed repeated
  kSingular,   // proto3 implicit-presence scalar
};

enum class ValueKind {
  kDouble,
  kFloat,
  kInt32,
  kInt64,
  kUint32,
  kUint64,
  kSint32,
  kSint64,
  kFixed32,
  kFixed64,
  kSfixed32,
  kSfixed64,
  kBool,
  kString,
  kBytes,
  kMessage,
  kEnum,
  kGroup,
};

struct FieldDescriptor {
  int number = 0;
  std::string name;
  ValueKind kind = ValueKind::kInt32;
  Label label = Label::kOptional;
  // True for a repeated field declared [packed=true] (or proto3 default-packed).
  bool packed = false;
  // Empty for top-level fields; set to the oneof name for oneof members.
  std::string oneof_name;
  // True when the field sits inside an extension range (or is an extension
  // declared outside the message). Such numbers are never "reused" claims.
  bool extension = false;
  // Type name for message/enum/group; informational for nested transforms.
  std::string type_name;
};

struct OneofDescriptor {
  std::string name;
};

struct MessageDescriptor {
  std::string full_name;
  std::vector<FieldDescriptor> fields;
  std::vector<OneofDescriptor> oneofs;
  // Reserved field numbers (reserved X;). Reuse of a reserved number is
  // rejected even when both schemas would otherwise agree.
  std::vector<int> reserved_numbers;
  // Extension ranges [start, end] declared on this message.
  struct Range {
    int start = 0;
    int end = 0;
  };
  std::vector<Range> extension_ranges;

  const FieldDescriptor* FindByNumber(int number) const {
    for (const auto& f : fields) {
      if (f.number == number) return &f;
    }
    return nullptr;
  }
};

// Canonical wire type of a scalar/structural value kind.
wire::WireType WireTypeFor(ValueKind kind);

// Whether presence is explicitly trackable on the wire (has-bit semantics):
// optional/required scalars, messages, and oneof members always carry
// presence; proto3 implicit singular scalars do not.
bool HasExplicitPresence(const FieldDescriptor& field);

// True when the value kinds share the same wire type and packed-compatible
// representation, i.e. a field can be copied verbatim after retagging.
bool WireCompatible(ValueKind a, ValueKind b);

}  // namespace dataeng

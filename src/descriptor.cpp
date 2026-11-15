#include "dataeng/descriptor.hpp"

namespace dataeng {

wire::WireType WireTypeFor(ValueKind kind) {
  switch (kind) {
    case ValueKind::kInt32:
    case ValueKind::kInt64:
    case ValueKind::kUint32:
    case ValueKind::kUint64:
    case ValueKind::kSint32:
    case ValueKind::kSint64:
    case ValueKind::kBool:
    case ValueKind::kEnum:
      return wire::WireType::kVarint;
    case ValueKind::kFixed64:
    case ValueKind::kDouble:
    case ValueKind::kSfixed64:
      return wire::WireType::kFixed64;
    case ValueKind::kString:
    case ValueKind::kBytes:
    case ValueKind::kMessage:
      return wire::WireType::kLengthDelimited;
    case ValueKind::kFixed32:
    case ValueKind::kFloat:
    case ValueKind::kSfixed32:
      return wire::WireType::kFixed32;
    case ValueKind::kGroup:
      return wire::WireType::kStartGroup;
  }
  return wire::WireType::kVarint;
}

bool HasExplicitPresence(const FieldDescriptor& field) {
  if (field.label == Label::kRepeated) return false;
  if (!field.oneof_name.empty()) return true;
  if (field.kind == ValueKind::kMessage || field.kind == ValueKind::kGroup) {
    return true;
  }
  // proto3 implicit-presence singular fields are the only scalar case without
  // an explicit has-bit.
  return field.label != Label::kSingular;
}

bool WireCompatible(ValueKind a, ValueKind b) {
  return WireTypeFor(a) == WireTypeFor(b);
}

}  // namespace dataeng

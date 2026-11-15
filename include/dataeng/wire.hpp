#pragma once

#include <cstdint>
#include <string_view>
#include <vector>

#include "dataeng/status.hpp"

// Minimal, dependency-free Protobuf wire-format primitives.
//
// The library deliberately operates on the wire representation rather than on
// generated message classes: this is what lets it preserve unknown fields,
// extension ranges and has-bit (presence) semantics untouched. Everything that
// is not explicitly remapped is copied byte-for-byte.
namespace dataeng::wire {

enum class WireType : uint32_t {
  kVarint = 0,
  kFixed64 = 1,
  kLengthDelimited = 2,
  kStartGroup = 3,
  kEndGroup = 4,
  kFixed32 = 5,
};

// One top-level (or nested) field occurrence as it appeared on the wire.
// `payload` is the raw payload *excluding* the tag varint:
//   varint/fixed: the raw value bytes,
//   length-delimited: the raw bytes after the length prefix,
//   group: the raw bytes between SGROUP and EGROUP (exclusive).
// Repeated fields produce several RawField entries with the same number.
struct RawField {
  int number = 0;
  WireType wire = WireType::kVarint;
  std::string_view payload;
};

// Encode a tag (field number + wire type) as an unsigned varint.
void AppendTag(std::string& out, int field_number, WireType wire);

// Encode a 32-bit length prefix and append a length-delimited payload.
void AppendLengthDelimited(std::string& out, std::string_view payload);

// Re-emit a parsed field verbatim (tag + payload) under a possibly new field
// number. When new_number == field.number the original bytes are reproduced.
void EmitField(std::string& out, const RawField& field, int new_number);

// Parse every field of a (sub)message. The returned views point into `input`
// and stay valid as long as `input` is alive and unmodified.
Status ParseMessage(std::string_view input, std::vector<RawField>& fields);

// Convenience: varint helpers used by packed-field handling and tests.
Status AppendVarint(std::string& out, uint64_t value);
Status ReadVarint(std::string_view data, size_t& cursor, uint64_t& value);

}  // namespace dataeng::wire

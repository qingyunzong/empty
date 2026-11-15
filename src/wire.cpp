#include "dataeng/wire.hpp"

namespace dataeng::wire {

namespace {

constexpr uint32_t kMaxVarintBytes = 10;

}  // namespace

Status AppendVarint(std::string& out, uint64_t value) {
  while (value >= 0x80) {
    out.push_back(static_cast<char>((value & 0x7F) | 0x80));
    value >>= 7;
  }
  if (out.size() == static_cast<size_t>(-1)) {
    return Status::Error(StatusCode::kInvalidArgument, "output too large");
  }
  out.push_back(static_cast<char>(value));
  return Status::Ok();
}

Status ReadVarint(std::string_view data, size_t& cursor, uint64_t& value) {
  value = 0;
  int shift = 0;
  for (uint32_t i = 0; i < kMaxVarintBytes; ++i) {
    if (cursor >= data.size()) {
      return Status::Error(StatusCode::kMalformedWire, "truncated varint");
    }
    uint8_t byte = static_cast<uint8_t>(data[cursor++]);
    if (i == kMaxVarintBytes - 1) {
      // The 10th byte may only carry the single remaining bit.
      if ((byte & 0x7E) != 0) {
        return Status::Error(StatusCode::kMalformedWire, "varint overflow");
      }
    }
    value |= static_cast<uint64_t>(byte & 0x7F) << shift;
    if ((byte & 0x80) == 0) {
      return Status::Ok();
    }
    shift += 7;
  }
  return Status::Error(StatusCode::kMalformedWire, "unterminated varint");
}

void AppendTag(std::string& out, int field_number, WireType wire) {
  uint64_t tag = (static_cast<uint64_t>(field_number) << 3) |
                 static_cast<uint64_t>(wire);
  AppendVarint(out, tag);
}

void AppendLengthDelimited(std::string& out, std::string_view payload) {
  AppendVarint(out, payload.size());
  out.append(payload);
}

void EmitField(std::string& out, const RawField& field, int new_number) {
  AppendTag(out, new_number, field.wire);
  if (field.wire == WireType::kStartGroup) {
    out.append(field.payload);
    AppendTag(out, new_number, WireType::kEndGroup);
  } else if (field.wire == WireType::kLengthDelimited) {
    AppendLengthDelimited(out, field.payload);
  } else {
    out.append(field.payload);
  }
}

Status ParseMessage(std::string_view input, std::vector<RawField>& fields) {
  size_t cursor = 0;
  struct GroupFrame {
    int number;
    size_t payload_start;
  };
  std::vector<GroupFrame> group_stack;

  while (cursor < input.size()) {
    const size_t field_start = cursor;
    uint64_t tag = 0;
    if (Status s = ReadVarint(input, cursor, tag); !s.ok()) return s;
    if (tag == 0) {
      return Status::Error(StatusCode::kMalformedWire, "tag must be non-zero");
    }
    uint32_t raw_wire = static_cast<uint32_t>(tag & 0x7);
    int number = static_cast<int>(tag >> 3);
    if (number == 0) {
      return Status::Error(StatusCode::kMalformedWire, "field number 0");
    }
    auto wt = static_cast<WireType>(raw_wire);

    if (!group_stack.empty() &&
        raw_wire == static_cast<uint32_t>(WireType::kEndGroup)) {
      if (number != group_stack.back().number) {
        return Status::Error(StatusCode::kMalformedWire,
                             "mismatched group end tag");
      }
      fields.push_back(RawField{
          group_stack.back().number, WireType::kStartGroup,
          input.substr(group_stack.back().payload_start,
                       field_start - group_stack.back().payload_start)});
      group_stack.pop_back();
      continue;
    }

    switch (wt) {
      case WireType::kVarint: {
        uint64_t dummy = 0;
        size_t value_start = cursor;
        if (Status s = ReadVarint(input, cursor, dummy); !s.ok()) return s;
        if (group_stack.empty()) {
          fields.push_back({number, wt,
                            input.substr(value_start, cursor - value_start)});
        }
        break;
      }
      case WireType::kFixed64: {
        if (cursor + 8 > input.size()) {
          return Status::Error(StatusCode::kMalformedWire, "truncated fixed64");
        }
        if (group_stack.empty()) {
          fields.push_back({number, wt, input.substr(cursor, 8)});
        }
        cursor += 8;
        break;
      }
      case WireType::kLengthDelimited: {
        uint64_t length = 0;
        size_t length_start = cursor;
        if (Status s = ReadVarint(input, cursor, length); !s.ok()) return s;
        if (length > input.size() - cursor) {
          return Status::Error(StatusCode::kMalformedWire,
                               "length-delimited payload overruns message");
        }
        if (group_stack.empty()) {
          (void)length_start;
          fields.push_back({number, wt,
                            input.substr(cursor, static_cast<size_t>(length))});
        }
        cursor += static_cast<size_t>(length);
        break;
      }
      case WireType::kStartGroup:
        group_stack.push_back({number, cursor});
        if (group_stack.size() > 64) {
          return Status::Error(StatusCode::kUnsupported,
                               "group nesting too deep");
        }
        break;
      case WireType::kEndGroup:
        return Status::Error(StatusCode::kMalformedWire,
                             "unexpected end-group tag");
      case WireType::kFixed32: {
        if (cursor + 4 > input.size()) {
          return Status::Error(StatusCode::kMalformedWire, "truncated fixed32");
        }
        if (group_stack.empty()) {
          fields.push_back({number, wt, input.substr(cursor, 4)});
        }
        cursor += 4;
        break;
      }
      default:
        return Status::Error(StatusCode::kMalformedWire, "unknown wire type");
    }
  }

  if (!group_stack.empty()) {
    return Status::Error(StatusCode::kMalformedWire, "unterminated group");
  }
  return Status::Ok();

}

}  // namespace dataeng::wire

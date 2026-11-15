#pragma once

#include <string>
#include <utility>

namespace dataeng {

enum class StatusCode {
  kOk = 0,
  kInvalidArgument,
  kWireTypeConflict,
  kFieldNumberReuse,
  kMalformedWire,
  kCollision,
  kUnsupported,
};

struct Status {
  StatusCode code = StatusCode::kOk;
  std::string message;

  Status() = default;
  Status(StatusCode c, std::string msg) : code(c), message(std::move(msg)) {}

  static Status Ok() { return Status{}; }
  static Status Error(StatusCode c, std::string msg) {
    return Status{c, std::move(msg)};
  }

  bool ok() const { return code == StatusCode::kOk; }
  explicit operator bool() const { return ok(); }

  const std::string& what() const { return message; }
};

inline std::string_view StatusCodeName(StatusCode code) {
  switch (code) {
    case StatusCode::kOk: return "OK";
    case StatusCode::kInvalidArgument: return "INVALID_ARGUMENT";
    case StatusCode::kWireTypeConflict: return "WIRE_TYPE_CONFLICT";
    case StatusCode::kFieldNumberReuse: return "FIELD_NUMBER_REUSE";
    case StatusCode::kMalformedWire: return "MALFORMED_WIRE";
    case StatusCode::kCollision: return "COLLISION";
    case StatusCode::kUnsupported: return "UNSUPPORTED";
  }
  return "UNKNOWN";
}

}  // namespace dataeng

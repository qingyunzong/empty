#pragma once

#include <cstdint>

namespace fencing {

using HolderId = std::uint32_t;
using Token = std::uint64_t;
using Time = std::int64_t;
using Duration = std::int64_t;
using Value = std::int64_t;

inline constexpr Token kNoToken = 0;

} // namespace fencing

#pragma once

#include <cstdint>
#include <string>

namespace ar {

// Minimal SHA-1 used for cache keys and environment IDs.
class Sha1 {
public:
  Sha1();
  void update(const void* data, size_t len);
  std::string hex(); // finalizes; 40 lowercase hex chars

private:
  uint32_t h_[5];
  uint64_t len_;
  uint8_t buf_[64];
  size_t buflen_;
  void block(const uint8_t* p);
};

std::string sha1_hex(const std::string& s);

} // namespace ar

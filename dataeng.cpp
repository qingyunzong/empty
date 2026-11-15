#include <atomic>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "dataeng.hpp"

namespace dataeng {
namespace {

constexpr char32_t kReplacementChar = 0xFFFD;

enum WeightLevel {
  kLevelPrimary = 0,
  kLevelSecondary = 1,
  kLevelTertiary = 2,
  kLevelQuaternary = 3,
};

struct CodepointWeight {
  std::uint32_t primary;
  std::uint32_t secondary;
  std::uint32_t tertiary;
  std::uint32_t quaternary;
};

std::atomic<std::uint64_t>& global_generation_counter() {
  static std::atomic<std::uint64_t> counter{0};
  return counter;
}

std::uint64_t allocate_generation_id() {
  return global_generation_counter().fetch_add(1, std::memory_order_relaxed) + 1;
}

// 组合记号（NFD 分解的第二部分）到次级权重的映射。
std::uint32_t combining_secondary(char32_t mark) {
  switch (mark) {
    case 0x0300:
      return 5;  // grave
    case 0x0301:
      return 6;  // acute
    case 0x0302:
      return 7;  // circumflex
    case 0x0303:
      return 8;  // tilde
    case 0x0304:
      return 4;  // macron
    case 0x0306:
      return 9;  // breve
    case 0x0307:
      return 10;  // dot above
    case 0x0308:
      return 11;  // diaeresis
    case 0x030A:
      return 12;  // ring above
    case 0x030B:
      return 13;  // double acute
    case 0x030C:
      return 14;  // caron
    case 0x0327:
      return 15;  // cedilla
    case 0x0328:
      return 16;  // ogonek
    default:
      return 3;
  }
}

bool is_combining_mark(char32_t cp) {
  return cp >= 0x0300 && cp <= 0x036F;
}

// 预组合拉丁字符的 NFD 风格分解：返回基字符，accents 追加组合记号。
char32_t decompose_precomposed(char32_t cp, std::vector<char32_t>* accents) {
  auto add = [&](char32_t mark) { accents->push_back(mark); };
  switch (cp) {
    // 大写重音字母
    case 0x00C0: add(0x0300); return U'A';
    case 0x00C1: add(0x0301); return U'A';
    case 0x00C2: add(0x0302); return U'A';
    case 0x00C3: add(0x0303); return U'A';
    case 0x00C4: add(0x0308); return U'A';
    case 0x00C5: add(0x030A); return U'A';
    case 0x00C7: add(0x0327); return U'C';
    case 0x00C8: add(0x0300); return U'E';
    case 0x00C9: add(0x0301); return U'E';
    case 0x00CA: add(0x0302); return U'E';
    case 0x00CB: add(0x0308); return U'E';
    case 0x00CC: add(0x0300); return U'I';
    case 0x00CD: add(0x0301); return U'I';
    case 0x00CE: add(0x0302); return U'I';
    case 0x00CF: add(0x0308); return U'I';
    case 0x00D1: add(0x0303); return U'N';
    case 0x00D2: add(0x0300); return U'O';
    case 0x00D3: add(0x0301); return U'O';
    case 0x00D4: add(0x0302); return U'O';
    case 0x00D5: add(0x0303); return U'O';
    case 0x00D6: add(0x0308); return U'O';
    case 0x00D9: add(0x0300); return U'U';
    case 0x00DA: add(0x0301); return U'U';
    case 0x00DB: add(0x0302); return U'U';
    case 0x00DC: add(0x0308); return U'U';
    case 0x00DD: add(0x0301); return U'Y';
    // 小写重音字母
    case 0x00E0: add(0x0300); return U'a';
    case 0x00E1: add(0x0301); return U'a';
    case 0x00E2: add(0x0302); return U'a';
    case 0x00E3: add(0x0303); return U'a';
    case 0x00E4: add(0x0308); return U'a';
    case 0x00E5: add(0x030A); return U'a';
    case 0x00E7: add(0x0327); return U'c';
    case 0x00E8: add(0x0300); return U'e';
    case 0x00E9: add(0x0301); return U'e';
    case 0x00EA: add(0x0302); return U'e';
    case 0x00EB: add(0x0308); return U'e';
    case 0x00EC: add(0x0300); return U'i';
    case 0x00ED: add(0x0301); return U'i';
    case 0x00EE: add(0x0302); return U'i';
    case 0x00EF: add(0x0308); return U'i';
    case 0x00F1: add(0x0303); return U'n';
    case 0x00F2: add(0x0300); return U'o';
    case 0x00F3: add(0x0301); return U'o';
    case 0x00F4: add(0x0302); return U'o';
    case 0x00F5: add(0x0303); return U'o';
    case 0x00F6: add(0x0308); return U'o';
    case 0x00F9: add(0x0300); return U'u';
    case 0x00FA: add(0x0301); return U'u';
    case 0x00FB: add(0x0302); return U'u';
    case 0x00FC: add(0x0308); return U'u';
    case 0x00FD: add(0x0301); return U'y';
    case 0x00FF: add(0x0308); return U'y';
    // 额外常见预组合字符
    case 0x0100: add(0x0304); return U'A';
    case 0x0101: add(0x0304); return U'a';
    case 0x0106: add(0x0301); return U'C';
    case 0x0107: add(0x0301); return U'c';
    case 0x010C: add(0x030C); return U'C';
    case 0x010D: add(0x030C); return U'c';
    case 0x0112: add(0x0304); return U'E';
    case 0x0113: add(0x0304); return U'e';
    case 0x011A: add(0x0328); return U'E';
    case 0x011B: add(0x0328); return U'e';
    case 0x0147: add(0x030C); return U'N';
    case 0x0148: add(0x030C); return U'n';
    case 0x0158: add(0x030C); return U'R';
    case 0x0159: add(0x030C); return U'r';
    case 0x0160: add(0x030C); return U'S';
    case 0x0161: add(0x030C); return U's';
    case 0x016E: add(0x030A); return U'U';
    case 0x016F: add(0x030A); return U'u';
    case 0x0170: add(0x030B); return U'U';
    case 0x0171: add(0x030B); return U'u';
    case 0x017D: add(0x030C); return U'Z';
    case 0x017E: add(0x030C); return U'z';
    default:
      return cp;
  }
}

CodepointWeight base_weight(char32_t cp) {
  CodepointWeight w{0, 1, 2, 1};

  if (cp >= U'0' && cp <= U'9') {
    w.primary = 100 + static_cast<std::uint32_t>(cp - U'0');
    w.tertiary = 1;
    w.quaternary = 1;
    return w;
  }

  if ((cp >= U'A' && cp <= U'Z') || (cp >= U'a' && cp <= U'z')) {
    const char32_t lower = (cp >= U'A' && cp <= U'Z') ? cp + 32 : cp;
    w.primary = 200 + static_cast<std::uint32_t>(lower - U'a');
    w.tertiary = (cp >= U'A' && cp <= U'Z') ? 3u : 2u;
    return w;
  }

  if (cp == U' ') {
    w.primary = 0;
    w.secondary = 1;
    w.tertiary = 1;
    w.quaternary = 2;
    return w;
  }

  if (cp < 0x80) {
    // ASCII 标点/控制字符。
    w.primary = 0;
    w.secondary = 1;
    w.tertiary = 1;
    w.quaternary = 3;
    return w;
  }

  // 其他 Unicode 字母：按码位落入稳定区间，保证确定性。
  w.primary = 500 + (cp % 1000);
  w.tertiary = 2;
  w.quaternary = 1;
  return w;
}

// 解析一个 UTF-8 码位。成功返回 true 并推进 offset；失败返回 false。
bool decode_codepoint(std::string_view input,
                      std::size_t* offset,
                      char32_t* cp) {
  const std::size_t start = *offset;
  const auto byte_at = [&](std::size_t pos) -> unsigned char {
    return static_cast<unsigned char>(input[pos]);
  };
  const unsigned char first = byte_at(start);
  std::size_t length = 0;
  char32_t value = 0;

  if (first < 0x80) {
    length = 1;
    value = first;
  } else if ((first & 0xE0) == 0xC0) {
    length = 2;
    value = first & 0x1F;
  } else if ((first & 0xF0) == 0xE0) {
    length = 3;
    value = first & 0x0F;
  } else if ((first & 0xF8) == 0xF0) {
    length = 4;
    value = first & 0x07;
  } else {
    return false;
  }

  if (start + length > input.size()) return false;
  for (std::size_t i = 1; i < length; ++i) {
    const unsigned char continuation = byte_at(start + i);
    if ((continuation & 0xC0) != 0x80) return false;
    value = (value << 6) | (continuation & 0x3F);
  }

  // 拒绝超长编码、代理码位与超出 Unicode 范围的值。
  const bool overlong =
      (length == 2 && value < 0x80) || (length == 3 && value < 0x800) ||
      (length == 4 && value < 0x10000);
  if (overlong || value > 0x10FFFF ||
      (value >= 0xD800 && value <= 0xDFFF)) {
    return false;
  }

  *cp = value;
  *offset = start + length;
  return true;
}

// 把码位序列按 locale 展开（德语 ß；瑞典语尾接在基字符权重中处理）。
std::vector<char32_t> apply_locale_tailoring(const std::vector<char32_t>& cps,
                                             Locale locale) {
  std::vector<char32_t> out;
  out.reserve(cps.size());
  for (char32_t cp : cps) {
    if (locale == Locale::kDeDe) {
      switch (cp) {
        case 0x00DF:  // ß -> ss
          out.push_back(U's');
          out.push_back(U's');
          continue;
        case 0x1E9E:  // ẞ -> SS
          out.push_back(U'S');
          out.push_back(U'S');
          continue;
        default:
          break;
      }
    }
    out.push_back(cp);
  }
  return out;
}

struct LevelWeights {
  std::vector<std::uint32_t> primary;
  std::vector<std::uint32_t> secondary;
  std::vector<std::uint32_t> tertiary;
  std::vector<std::uint32_t> quaternary;
};

// locale 对码位的 primary 覆盖。优先识别分解前的预组合字符。
bool locale_primary_override(char32_t original,
                             Locale locale,
                             std::uint32_t* primary) {
  if (locale == Locale::kSvSe) {
    const char32_t key = original;
    switch (key) {
      case U'å':
      case U'Å':
        *primary = 300;
        return true;
      case U'ä':
      case U'Ä':
        *primary = 301;
        return true;
      case U'ö':
      case U'Ö':
        *primary = 302;
        return true;
      default:
        return false;
    }
  }
  return false;
}

// 定长 4 字节大端编码：0 保留为级别分隔符，权重偏移 +1 后落在 1..2^32，
// 保证字节字典序与数值序完全一致。
void append_weight(std::uint32_t value, std::vector<std::uint8_t>* out) {
  const std::uint64_t shifted = static_cast<std::uint64_t>(value) + 1;
  for (int shift = 24; shift >= 0; shift -= 8) {
    out->push_back(static_cast<std::uint8_t>((shifted >> shift) & 0xFF));
  }
}

void append_level(const std::vector<std::uint32_t>& weights,
                  std::vector<std::uint8_t>* out) {
  for (std::uint32_t weight : weights) {
    append_weight(weight, out);
  }
  out->push_back(0);
}

// 由归一化、locale 展开后的码位流构建分级权重。
LevelWeights build_levels(const std::vector<char32_t>& cps,
                          const CollationConfig& config) {
  LevelWeights levels;
  const bool secondary_on =
      static_cast<int>(config.strength) >= static_cast<int>(CollationStrength::kSecondary);
  const bool tertiary_on =
      static_cast<int>(config.strength) >= static_cast<int>(CollationStrength::kTertiary);
  const bool quaternary_on =
      static_cast<int>(config.strength) >=
      static_cast<int>(CollationStrength::kQuaternary);

  for (char32_t cp : cps) {
    if (is_combining_mark(cp)) {
      // 孤立组合记号：附加到最近一个 token 的次级权重。
      if (!levels.secondary.empty() && secondary_on) {
        levels.secondary.back() = combining_secondary(cp);
      }
      continue;
    }

    std::vector<char32_t> accents;
    char32_t base = cp;
    if (config.normalization == NormalizationMode::kNormalized) {
      base = decompose_precomposed(cp, &accents);
    }

    CodepointWeight w = base_weight(base);
    std::uint32_t overridden = 0;
    if (locale_primary_override(cp, config.locale, &overridden)) {
      w.primary = overridden;
    }
    if (w.primary != 0) {
      levels.primary.push_back(w.primary);
      if (secondary_on) {
        levels.secondary.push_back(
            accents.empty() ? w.secondary : combining_secondary(accents[0]));
      }
      if (tertiary_on) {
        levels.tertiary.push_back(w.tertiary);
      }
      if (quaternary_on) {
        levels.quaternary.push_back(w.quaternary);
      }
    } else if (quaternary_on) {
      // 标点/空白仅在第四级可见。
      levels.primary.push_back(0);
      levels.quaternary.push_back(w.quaternary);
    }
  }

  return levels;
}

std::vector<std::uint8_t> encode_levels(const LevelWeights& levels,
                                        CollationStrength strength) {
  std::vector<std::uint8_t> encoded;
  append_level(levels.primary, &encoded);
  if (static_cast<int>(strength) >=
      static_cast<int>(CollationStrength::kSecondary)) {
    append_level(levels.secondary, &encoded);
  }
  if (static_cast<int>(strength) >=
      static_cast<int>(CollationStrength::kTertiary)) {
    append_level(levels.tertiary, &encoded);
  }
  if (static_cast<int>(strength) >=
      static_cast<int>(CollationStrength::kQuaternary)) {
    append_level(levels.quaternary, &encoded);
  }
  return encoded;
}

struct DecodedInput {
  std::vector<char32_t> codepoints;
  bool has_invalid = false;
};

// 按策略解码 UTF-8。kReject 由调用方在 has_invalid 时抛异常。
DecodedInput decode_input(std::string_view input,
                          InvalidUtf8Policy policy) {
  DecodedInput decoded;
  std::size_t offset = 0;
  while (offset < input.size()) {
    char32_t cp = 0;
    if (decode_codepoint(input, &offset, &cp)) {
      decoded.codepoints.push_back(cp);
      continue;
    }
    decoded.has_invalid = true;
    if (policy == InvalidUtf8Policy::kReplace) {
      decoded.codepoints.push_back(kReplacementChar);
    }
    // quarantine/reject：跳过非法字节继续扫描，保持错误定位完整。
    ++offset;
  }
  return decoded;
}

constexpr std::uint8_t kQuarantinePrefix = 0xFF;

}  // namespace

std::size_t CollationConfigHash::operator()(
    const CollationConfig& config) const noexcept {
  std::size_t seed = std::hash<int>{}(static_cast<int>(config.locale));
  auto mix = [&seed](std::size_t value) {
    seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6) + (seed >> 2);
  };
  mix(static_cast<std::size_t>(config.strength));
  mix(static_cast<std::size_t>(config.normalization));
  mix(static_cast<std::size_t>(config.invalid_utf8_policy));
  mix(static_cast<std::size_t>(config.rule_version));
  return seed;
}

InvalidUtf8Error::InvalidUtf8Error(const std::string& message)
    : CollationError(message) {}

GenerationMismatchError::GenerationMismatchError(std::uint64_t lhs,
                                                 std::uint64_t rhs)
    : CollationError("collation keys from different generations are not "
                     "comparable"),
      lhs_generation(lhs),
      rhs_generation(rhs) {}

int compare(const CollationKey& lhs, const CollationKey& rhs) {
  if (lhs.generation_id() != rhs.generation_id()) {
    throw GenerationMismatchError(lhs.generation_id(), rhs.generation_id());
  }

  // 隔离键统一排在有效键之后；隔离键之间按原始字节排序。
  if (lhs.quarantined() != rhs.quarantined()) {
    return lhs.quarantined() ? 1 : -1;
  }

  if (!lhs.quarantined()) {
    if (lhs.bytes() < rhs.bytes()) return -1;
    if (rhs.bytes() < lhs.bytes()) return 1;
  }

  // 原始字符串作为最终并列键，保证全序。
  if (lhs.original() < rhs.original()) return -1;
  if (rhs.original() < lhs.original()) return 1;
  return 0;
}

bool operator<(const CollationKey& lhs, const CollationKey& rhs) {
  return compare(lhs, rhs) < 0;
}

bool operator==(const CollationKey& lhs, const CollationKey& rhs) {
  return compare(lhs, rhs) == 0;
}

CollationEngine::CollationEngine(CollationConfig config)
    : config_(std::move(config)), generation_id_(allocate_generation_id()) {}

CollationKey CollationEngine::make_key(std::string_view input) {
  std::lock_guard<std::mutex> lock(mutex_);

  const DecodedInput decoded =
      decode_input(input, config_.invalid_utf8_policy);

  // 拒绝策略下不分配索引，保证成功生成的键索引连续。
  if (decoded.has_invalid &&
      config_.invalid_utf8_policy == InvalidUtf8Policy::kReject) {
    throw InvalidUtf8Error(
        "invalid UTF-8 sequence rejected by engine policy");
  }

  CollationKey key;
  key.generation_id_ = generation_id_;
  key.index_ = next_index_++;
  key.original_.assign(input.begin(), input.end());

  if (decoded.has_invalid &&
      config_.invalid_utf8_policy == InvalidUtf8Policy::kQuarantine) {
    key.quarantined_ = true;
    key.bytes_.push_back(kQuarantinePrefix);
    return key;
  }

  const std::vector<char32_t> tailored =
      apply_locale_tailoring(decoded.codepoints, config_.locale);
  const LevelWeights levels = build_levels(tailored, config_);
  key.bytes_ = encode_levels(levels, config_.strength);
  return key;
}

std::shared_ptr<CollationEngine> CollationRegistry::engine_for(
    const CollationConfig& config) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto found = engines_.find(config);
  if (found != engines_.end()) {
    return found->second;
  }

  // 配置变化（含 rule_version 升级）：建立全新世代，索引序列重新开始，
  // 全局世代号单调递增，旧索引不会被重用。
  auto engine = std::make_shared<CollationEngine>(config);
  engines_.emplace(config, engine);
  by_generation_.emplace(engine->generation_id(), engine);
  return engine;
}

std::shared_ptr<CollationEngine> CollationRegistry::generation(
    std::uint64_t generation_id) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto found = by_generation_.find(generation_id);
  if (found == by_generation_.end()) return nullptr;
  return found->second;
}

std::size_t CollationRegistry::size() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return engines_.size();
}

}  // namespace dataeng

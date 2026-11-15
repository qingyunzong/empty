#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace dataeng {

// 排序强度：依次启用更高的区分级别。
enum class CollationStrength {
  kPrimary = 1,     // 仅基础字母
  kSecondary = 2,   // 基础字母 + 重音
  kTertiary = 3,    // 基础字母 + 重音 + 大小写
  kQuaternary = 4,  // 再区分标点/空白
};

// 归一化模式。kNormalized 在权重计算前做 NFD 风格分解，
// 使预组合字符与“基字符 + 组合记号”产生相同的排序键。
enum class NormalizationMode {
  kNone,
  kNormalized,
};

// 无效 UTF-8 的隔离策略。
enum class InvalidUtf8Policy {
  kReject,      // 抛出 InvalidUtf8Error
  kReplace,     // 以 U+FFFD 替换非法字节，参与正常排序
  kQuarantine,  // 标记隔离，统一排在所有有效键之后，组内按原始字节排序
};

// 调用方提供的 locale 尾接规则。
enum class Locale {
  kRoot,
  kEnUs,
  kDeDe,  // ä/ö/ü/ß 等德语展开
  kSvSe,  // å/ä/ö 作为独立字母排在 z 之后
};

// 一次排序键生成的完整配置世代。任一字段变化都视为新世代。
struct CollationConfig {
  Locale locale = Locale::kRoot;
  CollationStrength strength = CollationStrength::kTertiary;
  NormalizationMode normalization = NormalizationMode::kNormalized;
  InvalidUtf8Policy invalid_utf8_policy = InvalidUtf8Policy::kReject;
  std::uint32_t rule_version = 1;

  bool operator==(const CollationConfig&) const = default;
};

struct CollationConfigHash {
  std::size_t operator()(const CollationConfig& config) const noexcept;
};

class CollationError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class InvalidUtf8Error : public CollationError {
 public:
  explicit InvalidUtf8Error(const std::string& message);
};

class GenerationMismatchError : public CollationError {
 public:
  GenerationMismatchError(std::uint64_t lhs, std::uint64_t rhs);

  std::uint64_t lhs_generation;
  std::uint64_t rhs_generation;
};

// 版本化排序键。键只能在同一 generation 内比较；
// index 仅用于溯源，不参与排序语义。
class CollationKey {
 public:
  CollationKey() = default;

  std::uint64_t generation_id() const noexcept { return generation_id_; }
  std::uint64_t index() const noexcept { return index_; }
  bool quarantined() const noexcept { return quarantined_; }
  const std::string& original() const noexcept { return original_; }
  const std::vector<std::uint8_t>& bytes() const noexcept { return bytes_; }

 private:
  friend class CollationEngine;

  std::uint64_t generation_id_ = 0;
  std::uint64_t index_ = 0;
  bool quarantined_ = false;
  std::string original_;
  std::vector<std::uint8_t> bytes_;
};

// 同世代比较：先比排序键字节，再以原始字符串字节做最终并列键，保证全序。
// 世代不同时抛出 GenerationMismatchError。
int compare(const CollationKey& lhs, const CollationKey& rhs);
bool operator<(const CollationKey& lhs, const CollationKey& rhs);
bool operator==(const CollationKey& lhs, const CollationKey& rhs);

// 绑定单一配置世代的排序键工厂。独立构造时获得全局唯一的新世代号；
// 通常通过 CollationRegistry 获取以复用同配置世代。
class CollationEngine {
 public:
  explicit CollationEngine(CollationConfig config);

  const CollationConfig& config() const noexcept { return config_; }
  std::uint64_t generation_id() const noexcept { return generation_id_; }

  CollationKey make_key(std::string_view input);

 private:
  CollationConfig config_;
  std::uint64_t generation_id_;
  std::uint64_t next_index_ = 1;
  std::mutex mutex_;
};

// 配置世代注册表：相同配置复用同一引擎与索引序列，
// 规则升级（配置变化）分配全新世代并重置索引，旧世代仍可追溯、互不混用。
class CollationRegistry {
 public:
  CollationRegistry() = default;

  std::shared_ptr<CollationEngine> engine_for(const CollationConfig& config);
  std::shared_ptr<CollationEngine> generation(std::uint64_t generation_id) const;
  std::size_t size() const;

 private:
  mutable std::mutex mutex_;
  std::unordered_map<CollationConfig,
                     std::shared_ptr<CollationEngine>,
                     CollationConfigHash>
      engines_;
  std::unordered_map<std::uint64_t, std::shared_ptr<CollationEngine>> by_generation_;
};

}  // namespace dataeng

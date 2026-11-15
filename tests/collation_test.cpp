#include <algorithm>
#include <iostream>
#include <string>
#include <vector>

#include "dataeng.hpp"

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(condition)                                            \
  do {                                                             \
    ++g_checks;                                                    \
    if (!(condition)) {                                            \
      ++g_failures;                                                \
      std::cerr << "CHECK failed: " #condition " at " << __FILE__  \
                << ":" << __LINE__ << "\n";                        \
    }                                                              \
  } while (false)

#define CHECK_THROWS(expression, exception_type)                   \
  do {                                                             \
    ++g_checks;                                                    \
    bool caught = false;                                          \
    try {                                                         \
      (void)(expression);                                         \
    } catch (const exception_type&) {                             \
      caught = true;                                              \
    } catch (...) {                                               \
    }                                                             \
    if (!caught) {                                                \
      ++g_failures;                                                \
      std::cerr << "CHECK_THROWS failed: " #expression " at "     \
                << __FILE__ << ":" << __LINE__ << "\n";           \
    }                                                             \
  } while (false)

using dataeng::CollationConfig;
using dataeng::CollationEngine;
using dataeng::CollationKey;
using dataeng::CollationRegistry;
using dataeng::CollationStrength;
using dataeng::GenerationMismatchError;
using dataeng::InvalidUtf8Error;
using dataeng::InvalidUtf8Policy;
using dataeng::Locale;
using dataeng::NormalizationMode;

CollationRegistry g_registry;

CollationEngine* make_engine(const CollationConfig& config) {
  return g_registry.engine_for(config).get();
}

CollationConfig base_config() {
  CollationConfig config;
  config.strength = CollationStrength::kTertiary;
  config.normalization = NormalizationMode::kNormalized;
  return config;
}

std::vector<std::string> sort_strings(CollationEngine* eng,
                                      std::vector<std::string> values) {
  std::vector<CollationKey> keys;
  keys.reserve(values.size());
  for (const std::string& value : values) {
    keys.push_back(eng->make_key(value));
  }
  std::sort(keys.begin(), keys.end());
  std::vector<std::string> result;
  result.reserve(keys.size());
  for (const CollationKey& key : keys) {
    result.push_back(key.original());
  }
  return result;
}

void test_basic_alphabet() {
  CollationEngine* eng = make_engine(base_config());

  const std::vector<std::string> result =
      sort_strings(eng, {"banana", "apple", "cherry"});
  CHECK(result == std::vector<std::string>({"apple", "banana", "cherry"}));

  const std::vector<std::string> mixed =
      sort_strings(eng, {"banana", "1apple", "apple"});
  CHECK(mixed == std::vector<std::string>({"1apple", "apple", "banana"}));
}

void test_strength_levels() {
  CollationConfig config = base_config();

  config.strength = CollationStrength::kPrimary;
  CollationEngine* primary = make_engine(config);
  // primary 级别下排序键字节相同；原始字符串作为最终并列键区分。
  CHECK(primary->make_key("abc").bytes() ==
        primary->make_key("ABC").bytes());
  CHECK(primary->make_key("abc").bytes() ==
        primary->make_key("ábc").bytes());
  CHECK(dataeng::compare(primary->make_key("ABC"),
                         primary->make_key("abc")) < 0);

  config.strength = CollationStrength::kSecondary;
  CollationEngine* secondary = make_engine(config);
  CHECK(secondary->make_key("abc").bytes() ==
        secondary->make_key("ABC").bytes());
  CHECK(dataeng::compare(secondary->make_key("abc"),
                         secondary->make_key("ábc")) < 0);

  config.strength = CollationStrength::kTertiary;
  CollationEngine* tertiary = make_engine(config);
  CHECK(dataeng::compare(tertiary->make_key("abc"),
                         tertiary->make_key("ABC")) < 0);
  CHECK(dataeng::compare(tertiary->make_key("abc"),
                         tertiary->make_key("ábc")) < 0);

  // 未启用第四级时标点/空白不可见。
  CollationEngine* tertiary_no_punct = make_engine(config);
  CHECK(tertiary_no_punct->make_key("ab").bytes() ==
        tertiary_no_punct->make_key("a b").bytes());

  config.strength = CollationStrength::kQuaternary;
  CollationEngine* quaternary = make_engine(config);
  CHECK(dataeng::compare(quaternary->make_key("ab"),
                         quaternary->make_key("a b")) != 0);
}

void test_normalization_equivalence() {
  CollationConfig config = base_config();
  config.strength = CollationStrength::kTertiary;
  config.normalization = NormalizationMode::kNormalized;
  CollationEngine* normalized = make_engine(config);

  // U+00E4（ä）与 a + U+0308（组合分音符）排序键等价。
  const std::string composed = "ä";
  const std::string decomposed = std::string("a") +
                                 static_cast<char>(0xCC) +
                                 static_cast<char>(0x88);
  CHECK(normalized->make_key(composed).bytes() ==
        normalized->make_key(decomposed).bytes());

  config.normalization = NormalizationMode::kNone;
  CollationEngine* raw = make_engine(config);
  CHECK(raw->make_key(composed).bytes() !=
        raw->make_key(decomposed).bytes());
}

void test_invalid_utf8_policies() {
  const std::string invalid = std::string("a") +
                              static_cast<char>(0xFF) +
                              static_cast<char>(0xFE) + "b";
  const std::string truncated =
      std::string("x") + static_cast<char>(0xC3) + "y";

  CollationConfig reject = base_config();
  reject.invalid_utf8_policy = InvalidUtf8Policy::kReject;
  CollationEngine* reject_engine = make_engine(reject);
  CHECK_THROWS(reject_engine->make_key(invalid), InvalidUtf8Error);
  CHECK_THROWS(reject_engine->make_key(truncated), InvalidUtf8Error);
  CHECK(reject_engine->make_key("valid").quarantined() == false);

  // 独立引擎验证：被拒绝的输入不占用索引，成功键从 1 连续计数。
  CollationEngine fresh_reject(reject);
  CHECK_THROWS(fresh_reject.make_key(invalid), InvalidUtf8Error);
  CHECK_THROWS(fresh_reject.make_key(truncated), InvalidUtf8Error);
  CHECK(fresh_reject.make_key("first").index() == 1);
  CHECK(fresh_reject.make_key("second").index() == 2);

  CollationConfig replace = base_config();
  replace.invalid_utf8_policy = InvalidUtf8Policy::kReplace;
  CollationEngine* replace_engine = make_engine(replace);
  const CollationKey replaced = replace_engine->make_key(invalid);
  CHECK(replaced.quarantined() == false);

  CollationConfig quarantine = base_config();
  quarantine.invalid_utf8_policy = InvalidUtf8Policy::kQuarantine;
  CollationEngine* quarantine_engine = make_engine(quarantine);
  const CollationKey bad_key = quarantine_engine->make_key(invalid);
  const CollationKey good_key = quarantine_engine->make_key("zzz");
  CHECK(bad_key.quarantined());
  CHECK(dataeng::compare(good_key, bad_key) < 0);

  const std::string invalid_other =
      std::string("a") + static_cast<char>(0xFF) + "c";
  const CollationKey other_key = quarantine_engine->make_key(invalid_other);
  CHECK(other_key.quarantined());
  CHECK(dataeng::compare(bad_key, other_key) != 0);
}

void test_locale_tailoring() {
  CollationConfig de = base_config();
  de.locale = Locale::kDeDe;
  de.strength = CollationStrength::kQuaternary;
  CollationEngine* de_engine = make_engine(de);

  // ß 展开为 ss：straße 与 strasse 排序等价。
  CHECK(de_engine->make_key("straße").bytes() ==
        de_engine->make_key("strasse").bytes());

  CollationConfig sv = base_config();
  sv.locale = Locale::kSvSe;
  sv.strength = CollationStrength::kPrimary;
  CollationEngine* sv_engine = make_engine(sv);

  // 瑞典语：å/ä/ö 排在 z 之后，内部 ö 最靠后。
  CHECK(sv_engine->make_key("z").bytes() <
        sv_engine->make_key("å").bytes());
  CHECK(sv_engine->make_key("ä").bytes() <
        sv_engine->make_key("ö").bytes());

  CollationConfig root = sv;
  root.locale = Locale::kRoot;
  CollationEngine* root_engine = make_engine(root);
  // root 下 ö 分解为 o + 分音符，primary 与 o 等价，因此在 z 之前。
  CHECK(root_engine->make_key("ö").bytes() <
        root_engine->make_key("z").bytes());
}

void test_generation_semantics() {
  CollationRegistry registry;
  CollationConfig v1 = base_config();
  v1.rule_version = 1;
  v1.invalid_utf8_policy = InvalidUtf8Policy::kQuarantine;

  CollationConfig v2 = v1;
  v2.rule_version = 2;

  const auto engine_v1 = registry.engine_for(v1);
  const auto engine_v1_again = registry.engine_for(v1);
  const auto engine_v2 = registry.engine_for(v2);

  CHECK(engine_v1.get() == engine_v1_again.get());
  CHECK(registry.size() == 2);
  CHECK(engine_v1->generation_id() != engine_v2->generation_id());
  CHECK(registry.generation(engine_v1->generation_id()).get() ==
        engine_v1.get());

  const CollationKey old_key = engine_v1->make_key("a");
  const CollationKey new_key = engine_v2->make_key("a");
  CHECK_THROWS(dataeng::compare(old_key, new_key),
               GenerationMismatchError);

  // 升级规则不重用旧索引：新世代索引从 1 重新计数，但世代号全局唯一。
  CHECK(old_key.index() == 1);
  CHECK(new_key.index() == 1);
  CHECK(engine_v2->generation_id() > engine_v1->generation_id());

  const CollationKey second = engine_v1->make_key("b");
  CHECK(second.index() == 2);

  // 独立构造的引擎同样获得新的全局世代号。
  CollationEngine standalone(v1);
  CHECK(standalone.generation_id() != engine_v1->generation_id());
}

void test_total_order_and_tiebreak() {
  CollationConfig config = base_config();
  config.strength = CollationStrength::kPrimary;
  CollationEngine* eng = make_engine(config);

  // primary 下排序键字节相同，原始字符串作为最终并列键。
  const CollationKey upper = eng->make_key("ABC");
  const CollationKey lower = eng->make_key("abc");
  CHECK(dataeng::compare(upper, lower) != 0);
  // 原始字节序：'A'(0x41) < 'a'(0x61)，大写在前。
  CHECK(dataeng::compare(upper, lower) < 0);
  CHECK(dataeng::compare(lower, upper) > 0);

  CHECK(dataeng::compare(eng->make_key("same"), eng->make_key("same")) == 0);

  std::vector<std::string> values = {
      "", "a", "A", "aa", "ab", "a b", "ä", "1", "9", "z", "Z"};
  const std::vector<std::string> ordered = sort_strings(eng, values);
  CHECK(ordered.size() == values.size());
  for (std::size_t i = 1; i < ordered.size(); ++i) {
    const int cmp =
        dataeng::compare(eng->make_key(ordered[i - 1]),
                         eng->make_key(ordered[i]));
    CHECK(cmp <= 0);
  }
}

void test_empty_string() {
  CollationEngine* eng = make_engine(base_config());
  const CollationKey empty = eng->make_key("");
  const CollationKey non_empty = eng->make_key("a");
  CHECK(empty.bytes().size() >= 1);
  CHECK(dataeng::compare(empty, non_empty) < 0);
  CHECK(empty.quarantined() == false);
}

}  // namespace

int main() {
  test_basic_alphabet();
  test_strength_levels();
  test_normalization_equivalence();
  test_invalid_utf8_policies();
  test_locale_tailoring();
  test_generation_semantics();
  test_total_order_and_tiebreak();
  test_empty_string();

  std::cout << (g_failures == 0 ? "ALL PASS" : "FAILURES") << ": checks="
            << g_checks << " failures=" << g_failures << "\n";
  return g_failures == 0 ? 0 : 1;
}

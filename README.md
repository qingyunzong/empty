# 字符串 collation 排序键

数据清洗引擎可直接接入的 C++20 版本化 collation key 组件（`dataeng`，无第三方依赖）。
调用方通过 `CollationConfig` 提供 locale、strength、normalization、无效 UTF-8 策略与
规则版本；排序键只在相同配置世代内比较，原始字符串作为最终并列键保证全序。

## 配置世代

- `CollationConfig`：`locale` / `strength` / `normalization` / `invalid_utf8_policy`
  / `rule_version`，任一字段变化即视为新世代。
- `CollationRegistry::engine_for(config)`：相同配置复用同一 `CollationEngine` 与索引序列；
  配置变化（含 `rule_version` 升级）分配全局唯一、单调递增的新世代号，索引从 1 重新计数，
  旧世代仍可通过 `generation(id)` 追溯，旧索引不会被重用。
- 跨世代比较抛出 `GenerationMismatchError`。

## 排序键与全序

- `CollationEngine::make_key(input)` 返回 `CollationKey`，携带 `generation_id`、
  单调 `index`、`bytes()` 排序键与 `original()` 原字符串。
- `dataeng::compare(a, b)` / `operator<`：先比排序键字节，再以原始字符串字节做最终并列键，
  因此任意两个同世代键都有确定次序（全序），`index` 不参与排序语义。
- 排序键按级别编码：primary（基础字母）→ secondary（重音）→ tertiary（大小写）→
  quaternary（标点/空白），由 `CollationStrength` 决定启用级别；各级别以定长 4 字节
  大端权重加 `0x00` 分隔，字节字典序即权重数值序。
- `NormalizationMode::kNormalized` 在权重计算前做 NFD 风格分解，使预组合字符（如 `ä`）
  与「基字符 + 组合记号」产生相同的排序键字节。
- locale 尾接：`kDeDe` 将 `ß/ẞ` 展开为 `ss/SS`；`kSvSe` 将 `å/ä/ö` 作为独立字母排在
  `z` 之后。

## 无效 UTF-8

解码器拒绝超长编码、截断序列、代理码位与超范围值，按 `InvalidUtf8Policy` 处理：

- `kReject`：抛出 `InvalidUtf8Error`。
- `kReplace`：以 U+FFFD 替换非法字节后参与正常排序。
- `kQuarantine`：键标记为隔离，统一排在所有有效键之后；隔离键之间按原始字节排序。

## 使用示例

```cpp
#include "dataeng.hpp"

dataeng::CollationRegistry registry;
dataeng::CollationConfig config;
config.locale = dataeng::Locale::kDeDe;
config.strength = dataeng::CollationStrength::kTertiary;
config.rule_version = 3;

auto engine = registry.engine_for(config);
auto k1 = engine->make_key("straße");
auto k2 = engine->make_key("strasse");  // 排序键字节相同，原字符串定最终次序
const int order = dataeng::compare(k1, k2);
```

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

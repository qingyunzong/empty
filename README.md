# dataeng — 可嵌入的 C++ Protobuf 迁移库

零依赖、C++20、可静态链接的 Protobuf 线格式（wire format）变换库。它不依赖
libprotobuf，直接在序列化字节上工作，因此天然保留 unknown field、扩展字段、
oneof 选择与 presence（has-bit）语义。

## 设计要点

- 线格式优先：只重写被映射字段的 tag，payload 原样拷贝；未映射/未知字段逐字节
  透传，作为目标消息的 unknown field（含游离的扩展号）。
- 建计划期强校验（`MigrationPlan::Build`），运行期不再因 schema 原因拒绝数据：
  - 字段号重用且 wire type 不一致 → `kWireTypeConflict` 拒绝；
  - 两个源字段落到同一目标字段号 / 占用 reserved 号 → `kFieldNumberReuse` 拒绝；
  - repeated 与 singular 基数冲突 → 拒绝。
- 兼容变化放行但记录到 `MigrationReport`，并区分严重级别：
  - `kInfo`：改名、packed 切换、oneof 成员迁移、字段新增/移除（按 unknown 保留）；
  - `kIrreversible`：同 wire 类型改语义（int32→uint32）、presence 丢失、oneof
    合并、required 目标字段无来源、扩展号变成普通字段、显式 drop。
- 运行期 oneof 冲突（同一条消息出现同一目标 oneof 的多个成员）计数并报告，
  不静默 last-writer-wins。
- `VerifyRoundTrip` 做 forward+reverse 往返校验：未知/扩展字节必须逐字节还原；
  映射字段在计划可逆时也必须完全还原。
- 支持嵌套消息（注册子计划后递归变换）与 group、packed/unpacked repeated。

## 模块

- `include/dataeng/wire.hpp` `src/wire.cpp`：varint、tag、length-delimited、
  group 的解析与重发，畸形输入返回 `kMalformedWire`。
- `include/dataeng/descriptor.hpp`：轻量 descriptor 模型（字段/oneof/扩展范围/
  reserved 号）与 wire 类型、presence 规则。
- `include/dataeng/migration.hpp` `src/migration.cpp`：迁移计划、冲突拒绝、
  不可逆变化报告、计划反转。
- `include/dataeng/transform.hpp` `src/transform.cpp`：运行期变换与统计。
- `include/dataeng/roundtrip.hpp` `src/roundtrip.cpp`：往返等价性校验。

## 用法

```cpp
#include "dataeng/dataeng.hpp"
using namespace dataeng;

MessageDescriptor old_desc{"Old", {
    {1, "id",   ValueKind::kInt64},
    {2, "name", ValueKind::kString}}};
MessageDescriptor new_desc{"New", {
    {1, "id",    ValueKind::kInt64},
    {3, "label", ValueKind::kString}}};

MessageMigration spec;
spec.src = &old_desc;
spec.dst = &new_desc;
spec.mappings = {{2, 3}};          // 显式改名；其余自动 passthrough

std::unique_ptr<MigrationPlan> plan;
Status st = MigrationPlan::Build(spec, plan);
if (!st.ok()) { /* kWireTypeConflict / kFieldNumberReuse ... */ }

std::string out;
TransformStats stats;
Transform(*plan, serialized_input, out, stats);   // 未知字节原样保留

for (const Change& c : plan->report().changes())
  if (c.severity == Severity::kIrreversible) { /* 上报不可逆变化 */ }

RoundTripResult rt;
VerifyRoundTrip(*plan, serialized_input, rt);    // rt.equivalent
```

显式丢弃字段用 `FieldMapping{src, 0, /*drop=*/true}`，会记录 `FIELD_DROPPED`
不可逆变化；而描述符里移除但未声明 drop 的字段仍按 unknown field 保留。

## 构建与测试

```bash
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

- `dataeng_tests`：102 项断言，覆盖冲突拒绝、unknown/扩展保留、oneof、
  presence、packed、嵌套、drop、往返。
- `dataeng_fuzz`：5000 轮随机合法消息，验证未知/扩展字段往返逐字节存活。

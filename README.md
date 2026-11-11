媒体接入宿主需要C++MPEG-TS节目表组件，接收188字节包并由调用方指定PID，处理adaptation字段、连续计数器及payload_unit_start_indicator后的pointer_field。分段可能跨包或同包多段，先校验section_length及CRC32/MPEG-2，再按table_id、extension、version汇齐0至last_section_number才原子发布。current_next为0只缓存，重复计数同载荷忽略、异载荷重置该PID待组装状态。用自行编码的包测试指针前结束旧段、后开始新段、丢包和版本交错，不能拼接不同版本。

## MPEG-TS 节目表分段组装组件

`mpegts::SectionAssembler`（`include/mpegts/section_assembler.hpp`）接收调用方指定
PID 的 188 字节 TS 包，重组 PSI 长表分段并在整表汇齐后原子发布。

能力：
- 解析 adaptation 字段（含 adaptation-only 与 discontinuity_indicator）。
- 校验 4 位连续计数器：同 CC 同载荷判重忽略，同 CC 异载荷或 CC 跳变复位该 PID 的
  待组装状态；adaptation-only 包不参与 CC 判重/丢包判定。
- 处理 payload_unit_start_indicator 与 pointer_field，支持分段跨包、同包多段，以及
  “指针前结束旧段、指针后开始新段”。
- 先校验 section_length 边界，再校验 CRC-32/MPEG-2（整段含 CRC 余数为 0）。
- 按 (table_id, table_id_extension, version) 分组，仅当 0..last_section_number 全部
  到齐才通过回调原子发布；current_next_indicator 为 0 的整表只缓存不发布。
- 同 section_number 相同载荷忽略；不同载荷复位该 PID 待组装状态并重建对应分组，
  绝不跨版本拼接分段。

构建与测试：

```
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试在 `tests/test_section_assembler.cpp` 中自行编码 TS 包（含真实分包复用器、指针
字段、跨包分段与 adaptation-only 包），覆盖指针前后新旧段、同包多段、丢包、同/异
载荷重复、版本交错、current_next 缓存、坏 CRC 与 discontinuity 标志。

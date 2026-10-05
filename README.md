# pngdec

C++20 极简 PNG 解码库，仅支持 **8 位灰度、非交错** PNG。

## 特性

- 逐块 CRC-32 校验，任何块校验失败即中止解码
- IHDR 必须为首个块，且字段完整校验（位深=8、颜色类型=0、压缩=0、滤波=0、交错=0）
- 支持全部五种行滤波（None/Sub/Up/Average/Paeth）逆算
- zlib 解压通过 `Inflater` 回调注入，库本身不依赖 zlib；
  测试中使用"现成字节"直通适配器
- 流式喂入：`feed()` 接受任意切分的字节块
- 长度溢出防护：维度派生尺寸、单块长度、IDAT 总量均有上限（`Limits` 可配）
- 坏块不发布部分图：只有完整解码成功（IEND 处理完毕）后 `takeImage()` 才有值；
  一旦进入失败状态，图像不可观测

## 接口

```cpp
#include <pngdec/pngdec.hpp>

pngdec::Decoder dec(inflater);          // inflater: (span<const uint8_t>, uint64_t expected)
                                        //         -> optional<vector<uint8_t>>
dec.feed(chunk);                        // 任意大小的输入块，可多次调用
dec.finish();                           // 输入结束；不完整则报 Truncated
if (dec.done()) {
  pngdec::Image img = *dec.takeImage(); // width, height, pixels（行主序灰度）
} else {
  pngdec::Error e = dec.error();        // to_string(e) 可得描述
}
```

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试见 `tests/`，结果记录见 `TEST_RESULTS.md`。

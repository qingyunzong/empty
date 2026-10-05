# png8 — 8 位灰度非交错 PNG 解码库

C++20 标准库实现，无第三方依赖。

## 能力范围

- 仅接受：bit depth 8、color type 0（灰度）、compression 0、filter method 0、interlace 0
- 逐块校验 CRC-32；IHDR 必须是第一个块；IDAT 必须连续；IEND 必填且为空
- 支持全部五种行滤波（None/Sub/Up/Average/Paeth）逆算
- zlib 解压通过可注入适配器 `png8::InflateFn` 完成，测试可注入"现成字节"桩；
  另附默认实现 `png8::zlib::inflate_stored`（stored-block zlib，含 Adler-32 校验）
- 任何坏块（CRC、顺序、长度、不支持特性）导致整体解码失败，不发布部分图：
  `DecodeResult::image` 仅在完整成功时才有值
- 长度溢出拒绝：声明块长超出剩余数据、尺寸乘积超过 4 GiB 上限均被拒绝

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
cd build && ctest --output-on-failure
```

## 用法

```cpp
#include "png8/png8.hpp"
#include "png8/zlib_stored.hpp"

auto result = png8::decode(bytes, png8::zlib::inflate_stored);
if (result) {
    // result.image->width / height / pixels（行主序，每像素 1 字节）
} else {
    // png8::to_string(result.error)
}
```

## 测试结果（实际运行记录）

环境：GCC 15.2.0，CMake/CTest 4.2.3，`-Wall -Wextra -Wpedantic` 零警告。

```
$ ctest --output-on-failure
1/6 Test #1: crc ..............................   Passed    0.01 sec
2/6 Test #2: zlib .............................   Passed    0.04 sec
3/6 Test #3: decode_basic .....................   Passed    0.01 sec
4/6 Test #4: filters ..........................   Passed    0.02 sec
5/6 Test #5: chunking .........................   Passed    0.02 sec
6/6 Test #6: errors ...........................   Passed    0.01 sec
100% tests passed, 0 tests failed out of 6
```

各用例检查数：

| 测试 | 覆盖 | 检查数 |
| --- | --- | --- |
| `crc` | 标准向量 + 与逐位参考实现比对 | 53 |
| `zlib` | stored 块往返、截断/坏 Adler/坏 NLEN/坏头拒绝 | 24 |
| `decode_basic` | 端到端解码、适配器侦察、现成字节桩、 ancillary 跳过 | 15 |
| `filters` | 五种滤波单独/混合，与独立逆算实现核对 | 126 |
| `chunking` | 任意 IDAT 切块（逐字节、随机、全边界） | 508 |
| `errors` | 坏 CRC、IHDR 顺序、溢出、截断等 20+ 负例，均无部分图 | 91 |

另在 `-fsanitize=address,undefined` 构建下复跑：6/6 通过
（LeakSanitizer 因沙箱 ptrace 限制以 `detect_leaks=0` 关闭）。

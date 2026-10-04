# linktool — 链接工具库

一个小型链接器库（C++20，仅标准库），演示符号解析、节垃圾回收、
地址布局与重定位，并附带一个独立的全图解释器用于对照验证。

## 功能

- **符号解析**：按入口符号、强/弱符号与节引用进行解析。
  - 强定义冲突 → 拒绝链接（报错并指出冲突双方）。
  - 弱定义冲突 → 按对象输入序，先出现者胜出。
  - 强定义可覆盖任意位置的弱定义；弱未定义符号解析为 0。
- **可达性回收（GC）**：从入口符号所在节与 `keep` 标记节出发，
  沿重定位引用遍历；循环引用合法（visited 集合保证终止）。
  不可达节被丢弃（`--no-gc` 可关闭）。
- **布局与重定位**：保留节按输出节名分组、按对齐约束分配唯一地址；
  支持 `ABS32` / `ABS64` / `PC32` 重定位。
- **绑定证据**：每条绑定记录引用者、中选定义及原因（强定义 /
  弱定义按输入序 / 强覆盖弱 / 弱未定义为 0）。
- **全图解释器对照**：`interpret_check` 在不作 GC 的完整对象图上
  独立地重新解析符号、重算可达闭包、重解释重定位，逐项核对
  链接器输出的绑定、保留节集合与重定位字节。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## CLI

```sh
ltlink [--entry SYM] [--base ADDR] [--no-gc] [--check] [-o OUT] OBJ...
```

`--check` 运行全图解释器对照，失败时退出码为 1。

## 对象文件格式（行式文本）

```
object <name>
section <name> size=<n> align=<n> [keep]
data <section> <offset> <hexbytes>
sym <name> <strong|weak> def <section> <offset>
sym <name> <strong|weak> undef
reloc <section> <offset> <ABS32|ABS64|PC32> <symbol> [addend]
```

`#` 之后为注释。示例见 `tests/data/`。

## 代码结构

- `include/lt/model.hpp` — 对象/节/符号/重定位数据模型
- `src/parse.cpp` — 文本对象格式解析器
- `src/link.cpp` — 解析、GC、布局、重定位、绑定证据
- `src/interp.cpp` — 全图解释器对照
- `src/main.cpp` — `ltlink` 命令行
- `tests/test_link.cpp` — 单元测试（CTest）

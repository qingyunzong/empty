# scorecli — 乐谱 CLI 解析器

解析音符、休止符、附点与连音组，时值以约分有理数表示，输出每个音符/休止符的起止拍点。

## 语法

```
score   := item*
item    := atom | tuplet
atom    := (pitch | 'R') duration?
pitch   := ('A'..'G') ['#'|'b'] [octave]     # 如 C4、F#5、Bb3
duration:= '/' 正整数 '.'*                   # /4=四分=1拍，/8=半拍；每个附点延长一半
tuplet  := '{' beats ':' item* '}'           # 组内总时值缩放到 beats 拍
beats   := 正整数 | 正整数 '/' 正整数          # 如 1、3/2
```

- 省略时值时默认四分音符（1 拍）。
- 连音组成员不要求等长：按各成员自然时值占比分配缩放后的总拍数。
- 连音组可嵌套，最大深度 16。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 使用

```sh
./build/scorecli 'C4/4 {1: D4/8 E4/8 F4/8} G4/2. R/8 Bb3/16'
# 或从标准输入读取
echo '{3/2: C4/4 D4/8 E4/8}' | ./build/scorecli
```

输出每行一个事件：`<音名|R> <起始拍> <结束拍>`，拍点为约分有理数（整数或 `n/d`）。

## 参考短乐谱展开

输入 `C4/4 {1: D4/8 E4/8 F4/8} G4/2. R/8 Bb3/16` 的输出（与 `tests/score_tests.cpp` 中的核验一致）：

```
C4  0    1
D4  1    4/3
E4  4/3  5/3
F4  5/3  2
G4  2    5
R   5    11/2
Bb3 11/2 23/4
```

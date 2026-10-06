# score-cli — 乐谱时值解析器

解析简单文本乐谱（音符、休止、附点、连音组），用约分有理数表示时值，
输出每个音符/休止的起止拍点。C++20，无第三方依赖。

## 语法

```
item   := note | rest | tuplet
note   := <pitch>/<denom>['.'...]     # c4/4  f#3/8.  bb4/16（全音符 = 4 拍）
rest   := r/<denom>['.'...]           # r/8
tuplet := '{' item... '}' = <beats>   # beats 为整数或分数，如 2、3/2
```

- 附点：每个点增加前一段时值的一半（`c4/8..` = 1/2+1/4+1/8 = 7/8 拍）。
- 连音组：把组内成员的书写时值总和等比缩放到 `beats` 拍；成员不要求等长。
- 连音组可嵌套，最深 16 层，超出报错。
- `#` 在行首/词首为注释；`,` 与 `|` 作为装饰性分隔符被忽略。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 使用

```sh
./build/score-cli examples/tuplet.score     # 或从 stdin 读：echo 'c4/4' | ./build/score-cli
```

每行输出一个事件：`<音名|r> <起始拍> <结束拍>`，拍点为约分后的有理数
（如 `3/2`）。示例：

```
$ ./build/score-cli examples/tuplet.score
c4 0 1/3
d4 1/3 2/3
e4 2/3 1
f#4 1 5/3
g4 5/3 2
a4 2 3
b4 3 7/2
c5 7/2 4
```

## 结构

- `src/rational.hpp` — 约分有理数（int64，自动 gcd 化简）
- `src/score.hpp` / `src/parser.cpp` — 词法/语法分析 + 连音组缩放展开
- `src/main.cpp` — CLI 入口
- `tests/test_score.cpp` — 单元测试（含手工核算的参考展开）
- `examples/*.score` / `*.expected` — CLI 金文件测试（CTest 逐字节比对）

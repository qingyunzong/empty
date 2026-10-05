# 实际运行结果

环境：g++ 15.2.0，CMake 4.2.3，Release 构建，C++20。

## CTest（2026-10-05 运行）

```
1/5 Test #1: basic ............................   Passed    0.01 sec
2/5 Test #2: cascade ..........................   Passed    0.01 sec
3/5 Test #3: random ...........................   Passed    0.02 sec
4/5 Test #4: limit ............................   Passed    0.83 sec
5/5 Test #5: verify ...........................   Passed    0.01 sec
100% tests passed, 0 tests failed out of 5
```

- `basic`：空程序、纯定长、范围内跳转保持短编码、越界跳转强制变长、
  位移边界 ±127/-128/+128、非法跳转目标拒绝。
- `cascade`：级联增长——指令 2 被迫变长后把指令 0 的目标推出短跳转
  范围，轨迹恰为 3 轮（翻转 [2]、[0]、[]），总长 136。
- `random`：200 个随机程序（≤12 跳转），松弛总长全部等于全枚举最优。
- `limit`：20 跳转程序全枚举（2^20 = 1,048,576 种组合）完成且与松弛
  一致；21 跳转正确返回"超出枚举上限"。
- `verify`：篡改偏移或编码选择的证书被 `verify` 拒绝。

## CLI 演示（examples/cascade.asm）

```
iteration trace (relaxation, all-short start)
  iter 0: total=130  flipped=[2]
  iter 1: total=133  flipped=[0]
  iter 2: total=136  flipped=[]  (fixpoint, all jumps legal)

offset certificate
  idx  offset  size  kind   detail
  0    0      5     long   -> insn 3  disp=130  legal
  1    5      125     fixed
  2    130      5     long   -> insn 0  disp=-135  legal
  3    135      1     fixed
  end offset (total length) = 136

certificate self-check: OK
exhaustive check over 2^2 short/long combinations:
  optimal total length = 136
  relaxation total     = 136
  relaxation is optimal: YES
```

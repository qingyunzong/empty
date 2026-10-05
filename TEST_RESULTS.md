# 测试结果记录

- 日期: 2026-10-05 17:22:22 CST
- 编译器: g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0
- CMake: cmake version 4.2.3
- 构建: Release, C++20, -Wall -Wextra -Wpedantic（零警告）
- 命令: `cmake -S . -B build && cmake --build build && cd build && ctest -V`

## 汇总

```
100% tests passed, 0 tests failed out of 6

Total Test time (real) =   0.02 sec
```

## 各用例实际输出（STATS 行）

```
1: STATS case=rounding checks=19
1: rounding: PASS
2: STATS case=saturation clipped_pos=9 clipped_neg=9
2: saturation: PASS
3: STATS case=delay group_delay=3 recovered=500
3: identity_delay: PASS
4: STATS case=chunked cfg=0 ratio=3/2 taps=5 in=1000 tail=4 out=1506 trials=8 match=yes
4: STATS case=chunked cfg=1 ratio=2/3 taps=3 in=999 tail=3 out=668 trials=8 match=yes
4: STATS case=chunked cfg=2 ratio=1/4 taps=4 in=777 tail=0 out=195 trials=8 match=yes
4: STATS case=chunked cfg=3 ratio=4/1 taps=7 in=513 tail=7 out=2080 trials=8 match=yes
4: STATS case=chunked cfg=4 ratio=147/160 taps=10 in=640 tail=11 out=599 trials=8 match=yes
4: STATS case=chunked cfg=5 ratio=1/1 taps=3 in=256 tail=2 out=258 trials=8 match=yes
4: STATS case=chunked cfg=6 ratio=5/7 taps=5 in=350 tail=9 out=257 trials=8 match=yes
4: chunked_vs_oneshot: PASS
5: STATS case=zero_tail z=0 out=180 expect=180
5: STATS case=zero_tail z=1 out=182 expect=182
5: STATS case=zero_tail z=2 out=183 expect=183
5: STATS case=zero_tail z=5 out=188 expect=188
5: STATS case=zero_tail z=13 out=200 expect=200
5: zero_tail: PASS
6: STATS case=dc phase_sum=3000 steady=390/406
6: dc: PASS
```

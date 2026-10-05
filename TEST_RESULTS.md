# 实际测试结果

记录时间: 2026-10-05 17:14:01 CST

## 环境

```
g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0
cmake version 4.2.3
```

## CTest（7/7 通过）

```
Test project /home/delin/.local/share/gsb-workbench/artifacts/aa3f4640eb144775a37f88a88b1936ff/run/A/attempt-003/workspace/build
    Start 1: inertial_cancel
1/7 Test #1: inertial_cancel ..................   Passed    0.01 sec
    Start 2: pulse_equal_delay
2/7 Test #2: pulse_equal_delay ................   Passed    0.01 sec
    Start 3: stale_generation
3/7 Test #3: stale_generation .................   Passed    0.01 sec
    Start 4: zero_delay_delta
4/7 Test #4: zero_delay_delta .................   Passed    0.01 sec
    Start 5: xor_glitch
5/7 Test #5: xor_glitch .......................   Passed    0.01 sec
    Start 6: delay_loop
6/7 Test #6: delay_loop .......................   Passed    0.01 sec
    Start 7: random_crosscheck
7/7 Test #7: random_crosscheck ................   Passed    0.11 sec

100% tests passed, 0 tests failed out of 7

Total Test time (real) =   0.15 sec
```

## 逐用例直接运行输出

```
$ ./build/gatesim_tests inertial_cancel
inertial_cancel: PASS
$ ./build/gatesim_tests pulse_equal_delay
pulse_equal_delay: PASS
$ ./build/gatesim_tests stale_generation
stale_generation: PASS
$ ./build/gatesim_tests zero_delay_delta
zero_delay_delta: PASS
$ ./build/gatesim_tests xor_glitch
xor_glitch: PASS
$ ./build/gatesim_tests delay_loop
delay_loop: PASS
$ ./build/gatesim_tests random_crosscheck
random_crosscheck: 200 seeds x 50 ticks passed
random_crosscheck: PASS
```

## 演示输出（./build/gatesim_demo）

```
=== scenario 1: inertial delay (BUF d=2) ===
pulses: width 1 @t2 (cancelled), width 2 @t6 (passes, fires at t8 = falling edge),
        width 5 @t12 (passes)
                       1 1 1 1 1 1 1 1 1 1 2 2
   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
a  0 0 1 0 0 0 1 1 0 0 0 0 1 1 1 1 1 0 0 0 0 0
n  0 0 0 0 0 0 0 0 1 1 0 0 0 0 1 1 1 1 1 0 0 0
value changes (time, delta, node, old->new, reason):
  t=2 d0 a 0->1  [stimulus]
  t=3 d0 a 1->0  [stimulus]
  t=6 d0 a 0->1  [stimulus]
  t=8 d0 a 1->0  [stimulus]
  t=8 d0 n 0->1  [gate 'g1' event fires (delay 2, gen 3)]
  t=10 d0 n 1->0  [gate 'g1' event fires (delay 2, gen 4)]
  t=12 d0 a 0->1  [stimulus]
  t=14 d0 n 0->1  [gate 'g1' event fires (delay 2, gen 5)]
  t=17 d0 a 1->0  [stimulus]
  t=19 d0 n 1->0  [gate 'g1' event fires (delay 2, gen 6)]
cancelled events (inertial):
  t=3 gate=g1 value=1 was_fire_time=4  [inertial cancel: input reverted after 1 tick(s) < delay 2]
stale events skipped (old generation):
  t=4 gate=g1 gen=1 current_gen=2  [stale event skipped: old generation never takes effect]

=== scenario 2: zero-delay delta chain (3 x NOT d=0) ===
                   
    0 1 2 3 4 5 6 7
 a  0 0 0 1 1 1 1 1
n1  1 1 1 0 0 0 0 0
n2  0 0 0 1 1 1 1 1
n3  1 1 1 0 0 0 0 0
value changes (time, delta, node, old->new, reason):
  t=3 d0 a 0->1  [stimulus]
  t=3 d1 n1 1->0  [zero-delay gate 'g1' (delta round 1)]
  t=3 d2 n2 0->1  [zero-delay gate 'g2' (delta round 2)]
  t=3 d3 n3 1->0  [zero-delay gate 'g3' (delta round 3)]
cancelled events (inertial):
stale events skipped (old generation):

=== scenario 3: two delays + zero-delay XOR (glitch) ===
                         1 1
     0 1 2 3 4 5 6 7 8 9 0 1
  a  0 0 1 1 1 1 0 0 0 0 0 0
 n1  0 0 0 1 1 1 1 0 0 0 0 0
 n2  0 0 0 0 0 1 1 1 1 0 0 0
out  0 0 0 1 1 0 0 1 1 0 0 0
value changes (time, delta, node, old->new, reason):
  t=2 d0 a 0->1  [stimulus]
  t=3 d0 n1 0->1  [gate 'd1' event fires (delay 1, gen 1)]
  t=3 d1 out 0->1  [zero-delay gate 'xr' (delta round 1)]
  t=5 d0 n2 0->1  [gate 'd3' event fires (delay 3, gen 1)]
  t=5 d1 out 1->0  [zero-delay gate 'xr' (delta round 1)]
  t=6 d0 a 1->0  [stimulus]
  t=7 d0 n1 1->0  [gate 'd1' event fires (delay 1, gen 2)]
  t=7 d1 out 0->1  [zero-delay gate 'xr' (delta round 1)]
  t=9 d0 n2 1->0  [gate 'd3' event fires (delay 3, gen 2)]
  t=9 d1 out 1->0  [zero-delay gate 'xr' (delta round 1)]
cancelled events (inertial):
stale events skipped (old generation):

=== scenario 4: two NOT d=1 in a loop (period-2 oscillator) ===
                       
    0 1 2 3 4 5 6 7 8 9
n1  0 1 0 1 0 1 0 1 0 1
n2  0 1 0 1 0 1 0 1 0 1
value changes (time, delta, node, old->new, reason):
  t=1 d0 n1 0->1  [gate 'g1' event fires (delay 1, gen 1)]
  t=1 d0 n2 0->1  [gate 'g2' event fires (delay 1, gen 1)]
  t=2 d0 n2 1->0  [gate 'g2' event fires (delay 1, gen 2)]
  t=2 d0 n1 1->0  [gate 'g1' event fires (delay 1, gen 2)]
  t=3 d0 n1 0->1  [gate 'g1' event fires (delay 1, gen 3)]
  t=3 d0 n2 0->1  [gate 'g2' event fires (delay 1, gen 3)]
  t=4 d0 n2 1->0  [gate 'g2' event fires (delay 1, gen 4)]
  t=4 d0 n1 1->0  [gate 'g1' event fires (delay 1, gen 4)]
  t=5 d0 n1 0->1  [gate 'g1' event fires (delay 1, gen 5)]
  t=5 d0 n2 0->1  [gate 'g2' event fires (delay 1, gen 5)]
  t=6 d0 n2 1->0  [gate 'g2' event fires (delay 1, gen 6)]
  t=6 d0 n1 1->0  [gate 'g1' event fires (delay 1, gen 6)]
  t=7 d0 n1 0->1  [gate 'g1' event fires (delay 1, gen 7)]
  t=7 d0 n2 0->1  [gate 'g2' event fires (delay 1, gen 7)]
  t=8 d0 n2 1->0  [gate 'g2' event fires (delay 1, gen 8)]
  t=8 d0 n1 1->0  [gate 'g1' event fires (delay 1, gen 8)]
  t=9 d0 n1 0->1  [gate 'g1' event fires (delay 1, gen 9)]
  t=9 d0 n2 0->1  [gate 'g2' event fires (delay 1, gen 9)]
cancelled events (inertial):
stale events skipped (old generation):

```

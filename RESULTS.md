# RESULTS

所有输出均为真实运行结果，未手工编辑。

## 环境

- Node.js: v22.22.1（仅标准库 + node:test，单机离线）
- 平台: Linux x86_64

## 验收命令 1: node --test test/*.test.js

```
TAP version 13
# Subtest: test/brute_force.test.js
ok 1 - test/brute_force.test.js
  ---
  duration_ms: 5894.302132
  type: 'test'
  ...
# Subtest: test/certificate.test.js
ok 2 - test/certificate.test.js
  ---
  duration_ms: 1271.689997
  type: 'test'
  ...
# Subtest: test/constraints.test.js
ok 3 - test/constraints.test.js
  ---
  duration_ms: 1068.021285
  type: 'test'
  ...
# Subtest: test/crash_recovery.test.js
ok 4 - test/crash_recovery.test.js
  ---
  duration_ms: 1261.114203
  type: 'test'
  ...
# Subtest: test/errors.test.js
ok 5 - test/errors.test.js
  ---
  duration_ms: 1047.623679
  type: 'test'
  ...
# Subtest: test/lifecycle.test.js
ok 6 - test/lifecycle.test.js
  ---
  duration_ms: 1193.498281
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5971.210268
```

## 验收命令 2: CLI 全流程（optimize / emit / rollback / explain）

```
$ node cli.js optimize
plan plan-578827242d33 written to /home/delin/.local/share/gsb-workbench/artifacts/992c2ed449ff41f7ad8eb01f162fdfb6/run/B/attempt-008/workspace/plan.json
  payments:
    A -> B amount=3500 days=2
    B -> D amount=2800 days=2
    D -> C amount=5100 days=1
  principal=32800 fee=117 freeze=170 days=2 amount=11400
  evaluated=63 feasible=63 tied=1
  certificate candidateSetHash=0cd179833682dc9bddbd210bf4fa141944cfa673566d768829bab25727490605
exit=0

$ node cli.js emit
executed plan-578827242d33
  payments:
    A -> B amount=3500 days=2
    B -> D amount=2800 days=2
    D -> C amount=5100 days=1
  cost: principal=32800 fee=117 freeze=170 days=2 amount=11400
  certificate candidateSetHash=0cd179833682dc9bddbd210bf4fa141944cfa673566d768829bab25727490605
  marker /home/delin/.local/share/gsb-workbench/artifacts/992c2ed449ff41f7ad8eb01f162fdfb6/run/B/attempt-008/workspace/.settle-state/plan-578827242d33.marker
exit=0

$ node cli.js rollback
error(72): plan plan-578827242d33 already executed; rollback refused, use rollback --reverse to emit a reverse plan
exit=72

$ node cli.js rollback --reverse
plan plan-578827242d33 already executed; rollback impossible, reverse plan plan-578827242d33-reversal written to /home/delin/.local/share/gsb-workbench/artifacts/992c2ed449ff41f7ad8eb01f162fdfb6/run/B/attempt-008/workspace/.settle-state/plan-578827242d33.reverse.json
exit=0

$ node cli.js explain
chosen plan plan-578827242d33
  principal=32800 fee=117 freeze=170 days=2 amount=11400
  certificate:
    evaluated=63 feasible=63 tied=1
    candidateSetHash=0cd179833682dc9bddbd210bf4fa141944cfa673566d768829bab25727490605
  infeasible candidates: 0
    violates fee: 0
    violates days: 0
    violates freeze: 0
    violates daily_amount: 0
  eliminated feasible candidates:
    A>B:3500|D>C:5100#o1,o2,o3,o4,o6
      reason: settled principal 30000 < optimal 32800
      principal=30000 fee=80 freeze=128 days=2 amount=8600
    A>B:3500|A>C:4200|B>D:2800|D>C:5100#o1,o2,o3,o5,o6
      reason: settled principal 28600 < optimal 32800
      principal=28600 fee=157 freeze=233 days=2 amount=15600
    A>B:3500|B>D:2800|C>A:4200|D>C:5100#o1,o2,o4,o5,o6
      reason: settled principal 28600 < optimal 32800
      principal=28600 fee=157 freeze=233 days=3 amount=15600
    A>B:3500|B>D:2800#o1,o2,o3,o4,o5
      reason: settled principal 27700 < optimal 32800
      principal=27700 fee=75 freeze=94 days=2 amount=6300
    A>B:10000|B>D:2800|D>C:5100#o1,o3,o4,o5,o6
      reason: settled principal 26300 < optimal 32800
      principal=26300 fee=134 freeze=268 days=2 amount=17900
    A>B:3500|A>C:4200|D>C:5100#o1,o2,o3,o6
      reason: settled principal 25800 < optimal 32800
      principal=25800 fee=120 freeze=191 days=2 amount=12800
    A>B:3500|C>A:4200|D>C:5100#o1,o2,o4,o6
      reason: settled principal 25800 < optimal 32800
      principal=25800 fee=120 freeze=191 days=3 amount=12800
    A>B:3500#o1,o2,o3,o4
      reason: settled principal 24900 < optimal 32800
      principal=24900 fee=38 freeze=52 days=2 amount=3500
    A>B:3500|B>D:2800|D>C:5100#o1,o2,o5,o6
      reason: settled principal 24400 < optimal 32800
      principal=24400 fee=117 freeze=170 days=2 amount=11400
    A>B:10000|D>C:5100#o1,o3,o4,o6
      reason: settled principal 23500 < optimal 32800
      principal=23500 fee=97 freeze=226 days=1 amount=15100
    A>B:3500|A>C:4200|B>D:2800#o1,o2,o3,o5
      reason: settled principal 23500 < optimal 32800
      principal=23500 fee=115 freeze=157 days=2 amount=10500
    A>B:3500|B>D:2800|C>A:4200#o1,o2,o4,o5
      reason: settled principal 23500 < optimal 32800
      principal=23500 fee=115 freeze=157 days=3 amount=10500
    B>A:6500|B>D:2800|D>C:5100#o2,o3,o4,o5,o6
      reason: settled principal 22800 < optimal 32800
      principal=22800 fee=125 freeze=215 days=2 amount=14400
    A>B:10000|A>C:4200|B>D:2800|D>C:5100#o1,o3,o5,o6
      reason: settled principal 22100 < optimal 32800
      principal=22100 fee=174 freeze=331 days=2 amount=22100
    A>B:10000|B>D:2800|C>A:4200|D>C:5100#o1,o4,o5,o6
      reason: settled principal 22100 < optimal 32800
      principal=22100 fee=174 freeze=331 days=3 amount=22100
    A>B:3500|D>C:5100#o1,o2,o6
      reason: settled principal 21600 < optimal 32800
      principal=21600 fee=80 freeze=128 days=2 amount=8600
    A>B:10000|B>D:2800#o1,o3,o4,o5
      reason: settled principal 21200 < optimal 32800
      principal=21200 fee=92 freeze=192 days=2 amount=12800
    A>B:3500|A>C:4200#o1,o2,o3
      reason: settled principal 20700 < optimal 32800
      principal=20700 fee=78 freeze=115 days=2 amount=7700
    A>B:3500|C>A:4200#o1,o2,o4
      reason: settled principal 20700 < optimal 32800
      principal=20700 fee=78 freeze=115 days=3 amount=7700
    B>A:6500|D>C:5100#o2,o3,o4,o6
      reason: settled principal 20000 < optimal 32800
      principal=20000 fee=88 freeze=173 days=2 amount=11600
    A>B:3500|B>D:2800#o1,o2,o5
      reason: settled principal 19300 < optimal 32800
      principal=19300 fee=75 freeze=94 days=2 amount=6300
    A>B:10000|A>C:4200|D>C:5100#o1,o3,o6
      reason: settled principal 19300 < optimal 32800
      principal=19300 fee=137 freeze=289 days=1 amount=19300
    A>B:10000|C>A:4200|D>C:5100#o1,o4,o6
      reason: settled principal 19300 < optimal 32800
      principal=19300 fee=137 freeze=289 days=3 amount=19300
    A>C:4200|B>A:6500|B>D:2800|D>C:5100#o2,o3,o5,o6
      reason: settled principal 18600 < optimal 32800
      principal=18600 fee=165 freeze=278 days=2 amount=18600
    B>A:6500|B>D:2800|C>A:4200|D>C:5100#o2,o4,o5,o6
      reason: settled principal 18600 < optimal 32800
      principal=18600 fee=165 freeze=278 days=3 amount=18600
    A>B:10000#o1,o3,o4
      reason: settled principal 18400 < optimal 32800
      principal=18400 fee=55 freeze=150 days=1 amount=10000
    A>B:10000|B>D:2800|D>C:5100#o1,o5,o6
      reason: settled principal 17900 < optimal 32800
      principal=17900 fee=134 freeze=268 days=2 amount=17900
    B>A:6500|B>D:2800#o2,o3,o4,o5
      reason: settled principal 17700 < optimal 32800
      principal=17700 fee=83 freeze=139 days=2 amount=9300
    A>B:10000|A>C:4200|B>D:2800#o1,o3,o5
      reason: settled principal 17000 < optimal 32800
      principal=17000 fee=132 freeze=255 days=2 amount=17000
    A>B:10000|B>D:2800|C>A:4200#o1,o4,o5
      reason: settled principal 17000 < optimal 32800
      principal=17000 fee=132 freeze=255 days=3 amount=17000
    A>B:3500#o1,o2
      reason: settled principal 16500 < optimal 32800
      principal=16500 fee=38 freeze=52 days=2 amount=3500
    B>D:2800|D>C:5100#o3,o4,o5,o6
      reason: settled principal 16300 < optimal 32800
      principal=16300 fee=79 freeze=118 days=2 amount=7900
    A>C:4200|B>A:6500|D>C:5100#o2,o3,o6
      reason: settled principal 15800 < optimal 32800
      principal=15800 fee=128 freeze=236 days=2 amount=15800
    B>A:6500|C>A:4200|D>C:5100#o2,o4,o6
      reason: settled principal 15800 < optimal 32800
      principal=15800 fee=128 freeze=236 days=3 amount=15800
    A>B:10000|D>C:5100#o1,o6
      reason: settled principal 15100 < optimal 32800
      principal=15100 fee=97 freeze=226 days=1 amount=15100
    B>A:6500#o2,o3,o4
      reason: settled principal 14900 < optimal 32800
      principal=14900 fee=46 freeze=97 days=2 amount=6500
    B>A:6500|B>D:2800|D>C:5100#o2,o5,o6
      reason: settled principal 14400 < optimal 32800
      principal=14400 fee=125 freeze=215 days=2 amount=14400
    A>B:10000|A>C:4200#o1,o3
      reason: settled principal 14200 < optimal 32800
      principal=14200 fee=95 freeze=213 days=1 amount=14200
    A>B:10000|C>A:4200#o1,o4
      reason: settled principal 14200 < optimal 32800
      principal=14200 fee=95 freeze=213 days=3 amount=14200
    D>C:5100#o3,o4,o6
      reason: settled principal 13500 < optimal 32800
      principal=13500 fee=42 freeze=76 days=1 amount=5100
    A>C:4200|B>A:6500|B>D:2800#o2,o3,o5
      reason: settled principal 13500 < optimal 32800
      principal=13500 fee=123 freeze=202 days=2 amount=13500
    B>A:6500|B>D:2800|C>A:4200#o2,o4,o5
      reason: settled principal 13500 < optimal 32800
      principal=13500 fee=123 freeze=202 days=3 amount=13500
    A>B:10000|B>D:2800#o1,o5
      reason: settled principal 12800 < optimal 32800
      principal=12800 fee=92 freeze=192 days=2 amount=12800
    A>C:4200|B>D:2800|D>C:5100#o3,o5,o6
      reason: settled principal 12100 < optimal 32800
      principal=12100 fee=119 freeze=181 days=2 amount=12100
    B>D:2800|C>A:4200|D>C:5100#o4,o5,o6
      reason: settled principal 12100 < optimal 32800
      principal=12100 fee=119 freeze=181 days=3 amount=12100
    B>A:6500|D>C:5100#o2,o6
      reason: settled principal 11600 < optimal 32800
      principal=11600 fee=88 freeze=173 days=2 amount=11600
    B>D:2800#o3,o4,o5
      reason: settled principal 11200 < optimal 32800
      principal=11200 fee=37 freeze=42 days=2 amount=2800
    A>C:4200|B>A:6500#o2,o3
      reason: settled principal 10700 < optimal 32800
      principal=10700 fee=86 freeze=160 days=2 amount=10700
    B>A:6500|C>A:4200#o2,o4
      reason: settled principal 10700 < optimal 32800
      principal=10700 fee=86 freeze=160 days=3 amount=10700
    A>B:10000#o1
      reason: settled principal 10000 < optimal 32800
      principal=10000 fee=55 freeze=150 days=1 amount=10000
    A>C:4200|D>C:5100#o3,o6
      reason: settled principal 9300 < optimal 32800
      principal=9300 fee=82 freeze=139 days=1 amount=9300
    C>A:4200|D>C:5100#o4,o6
      reason: settled principal 9300 < optimal 32800
      principal=9300 fee=82 freeze=139 days=3 amount=9300
    B>A:6500|B>D:2800#o2,o5
      reason: settled principal 9300 < optimal 32800
      principal=9300 fee=83 freeze=139 days=2 amount=9300
    #o3,o4
      reason: settled principal 8400 < optimal 32800
      principal=8400 fee=0 freeze=0 days=0 amount=0
    B>D:2800|D>C:5100#o5,o6
      reason: settled principal 7900 < optimal 32800
      principal=7900 fee=79 freeze=118 days=2 amount=7900
    A>C:4200|B>D:2800#o3,o5
      reason: settled principal 7000 < optimal 32800
      principal=7000 fee=77 freeze=105 days=2 amount=7000
    B>D:2800|C>A:4200#o4,o5
      reason: settled principal 7000 < optimal 32800
      principal=7000 fee=77 freeze=105 days=3 amount=7000
    B>A:6500#o2
      reason: settled principal 6500 < optimal 32800
      principal=6500 fee=46 freeze=97 days=2 amount=6500
    D>C:5100#o6
      reason: settled principal 5100 < optimal 32800
      principal=5100 fee=42 freeze=76 days=1 amount=5100
    A>C:4200#o3
      reason: settled principal 4200 < optimal 32800
      principal=4200 fee=40 freeze=63 days=1 amount=4200
    C>A:4200#o4
      reason: settled principal 4200 < optimal 32800
      principal=4200 fee=40 freeze=63 days=3 amount=4200
    B>D:2800#o5
      reason: settled principal 2800 < optimal 32800
      principal=2800 fee=37 freeze=42 days=2 amount=2800
exit=0

$ node cli.js explain --subset o1,o2
chosen plan plan-578827242d33
  principal=32800 fee=117 freeze=170 days=2 amount=11400
  certificate:
    evaluated=63 feasible=63 tied=1
    candidateSetHash=0cd179833682dc9bddbd210bf4fa141944cfa673566d768829bab25727490605
subset o1,o2
  principal=16500 fee=38 freeze=52 days=2 amount=3500
  eliminated: settled principal 16500 < optimal 32800
exit=0
```

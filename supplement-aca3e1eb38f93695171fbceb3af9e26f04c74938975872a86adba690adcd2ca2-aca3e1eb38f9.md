

补充核验记录（对应最终产物，区别于原模型会话）：
下列命令在对应产物提交的目录中执行。补充核验不属于 A/B 原始交互，未改写原轨迹。

A 产物提交：29b5f9374060fa6599c43d68de2a45585589598f

A 测试命令：npm test
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："\n> persistent-mode-array@1.0.0 test\n> tsc -p tsconfig.json && node --test dist/test/*.test.js\n\nTAP version 13\n# Subtest: mode: highest frequency wins, evidence reports the count\nok 1 - mode: highest frequency wins, evidence reports the count\n  ---\n  duration_ms: 17.139778\n  type: 'test'\n  ...\n# Subtest: mode: ties break to the smaller value\nok 2 - mode: ties break to the smaller value\n  ---\n  duration_ms: 1.594685\n  type: 'test'\n  ...\n# Subtest: empty range returns null\nok 3 - empty range returns null\n  ---\n  duration_ms: 0.965354\n  type: 'test'\n  ...\n# Subtest: block update is atomic and old versions stay queryable\nok 4 - block update is atomic and old versions stay queryable\n  ---\n  duration_ms: 1.517503\n  type: 'test'\n  ...\n# Subtest: invalid ranges and versions are rejected\nok 5 - invalid ranges and versions are rejected\n  ---\n  duration_ms: 1.938575\n  type: 'test'\n  ...\n# Subtest: randomized cross-check vs sorted-count model (replacements, old versions, empty ranges)\nok 6 - randomized cross-check vs sorted-count model (replacements, old versions, empty ranges)\n  ---\n  duration_ms: 31.935663\n  type: 'test'\n  ...\n1..6\n# tests 6\n# suites 0\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1009.700058\n"

A 预热命令：tsc -p tsconfig.json

A 检查：众数证据、原子发布与历史隔离
复现命令：/usr/bin/node '{support}/probe.mjs' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

A 探针完整输入文件 probe.mjs以 JSON 字符串记录，解码后可还原完整输入文件："import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';const ws=process.argv[2];const {PersistentModeArray}=await import(pathToFileURL(path.join(ws,'dist/src/mode-array.js')));const s=new PersistentModeArray([3,1,3,1]);const old=s.queryMode(0,0,4);const id=s.replaceRange(0,0,2,7);const fresh=s.queryMode(id,0,4);assert.deepEqual(old,{value:1,count:2});assert.deepEqual(fresh,{value:7,count:2});assert.deepEqual(s.queryMode(0,0,4),old);const n=s.versionCount;assert.throws(()=>s.replaceRange(id,0,5,9));assert.equal(s.versionCount,n);assert.equal(s.queryMode(id,0,0),null);assert.ok(Object.isFrozen(s.snapshot(0)));console.log('oldMode=1/2 newMode=7/2 rejectedBlockKeptVersion=true empty=null frozen=true');"

A 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/9df7badcaf504c79bd636c3be087397c/judge/pair/attempt-005/demonstration-A/demonstration/probe.mjs /home/delin/.local/share/gsb-workbench/artifacts/9df7badcaf504c79bd636c3be087397c/record/A/attempt-001/workspace\noldMode=1/2 newMode=7/2 rejectedBlockKeptVersion=true empty=null frozen=true\n"

B 产物提交：ebd96a169abdbb73f1360d7a572dbc211b816243

B 测试命令：npm test
退出码：0
完整输出以 JSON 字符串记录，解码后可还原完整原始输出："\n> versioned-mode-query@1.0.0 test\n> tsc -p tsconfig.json && node --test \"dist/test/*.test.js\"\n\nTAP version 13\n#   [随机核对] 非空范围对照 1074 次，空范围 366 次，全部一致\n# Subtest: rangeMode 基本语义\n    # Subtest: 返回众数值与频次证据\n    ok 1 - 返回众数值与频次证据\n      ---\n      duration_ms: 12.610976\n      type: 'test'\n      ...\n    # Subtest: 频次并列时取数值较小者\n    ok 2 - 频次并列时取数值较小者\n      ---\n      duration_ms: 1.270647\n      type: 'test'\n      ...\n    # Subtest: 子范围查询只统计区间内元素\n    ok 3 - 子范围查询只统计区间内元素\n      ---\n      duration_ms: 1.227292\n      type: 'test'\n      ...\n    # Subtest: 空范围（from > to）返回 null\n    ok 4 - 空范围（from > to）返回 null\n      ---\n      duration_ms: 0.997585\n      type: 'test'\n      ...\n    # Subtest: 越界范围与不存在的版本抛 RangeError\n    ok 5 - 越界范围与不存在的版本抛 RangeError\n      ---\n      duration_ms: 2.347636\n      type: 'test'\n      ...\n    1..5\nok 1 - rangeMode 基本语义\n  ---\n  duration_ms: 24.251848\n  type: 'suite'\n  ...\n# Subtest: 块更新原子性与版本持久化\n    # Subtest: 合法块更新产生新版本，旧版本仍可查询\n    ok 1 - 合法块更新产生新版本，旧版本仍可查询\n      ---\n      duration_ms: 3.246631\n      type: 'test'\n      ...\n    # Subtest: 非法块整体拒绝：越界下标\n    ok 2 - 非法块整体拒绝：越界下标\n      ---\n      duration_ms: 2.939785\n      type: 'test'\n      ...\n    # Subtest: 非法块整体拒绝：非整数值与块内重复下标\n    ok 3 - 非法块整体拒绝：非整数值与块内重复下标\n      ---\n      duration_ms: 2.037747\n      type: 'test'\n      ...\n    # Subtest: 空块为无操作，不产生新版本\n    ok 4 - 空块为无操作，不产生新版本\n      ---\n      duration_ms: 1.533201\n      type: 'test'\n      ...\n    1..4\nok 2 - 块更新原子性与版本持久化\n  ---\n  duration_ms: 11.585247\n  type: 'suite'\n  ...\n# Subtest: 随机核对：排序计数模型 vs 库实现\n    # Subtest: 随机替换 + 随机范围（含空范围）全量对照\n    ok 1 - 随机替换 + 随机范围（含空范围）全量对照\n      ---\n      duration_ms: 46.568328\n      type: 'test'\n      ...\n    1..1\nok 3 - 随机核对：排序计数模型 vs 库实现\n  ---\n  duration_ms: 47.076738\n  type: 'suite'\n  ...\n1..3\n# tests 10\n# suites 3\n# pass 10\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 768.685215\n"

B 预热命令：tsc -p tsconfig.json

B 检查：众数证据、原子发布与历史隔离
复现命令：/usr/bin/node '{support}/probe.mjs' '{workspace}'
将下列探针按文件名保存到单独目录，用该目录替换 {support}，用上述提交检出的源码目录替换 {workspace}；在源码目录执行。探针是补充核验输入。

B 探针完整输入文件 probe.mjs以 JSON 字符串记录，解码后可还原完整输入文件："import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';const ws=process.argv[2];const {VersionedArray}=await import(pathToFileURL(path.join(ws,'dist/src/versioned-array.js')));const s=new VersionedArray([3,1,3,1]);const old=s.rangeMode(0,0,3);const id=s.applyBlock([{index:0,value:7},{index:1,value:7}]).id;const fresh=s.rangeMode(id,0,3);assert.equal(old.value,1);assert.equal(old.frequency,2);assert.equal(fresh.value,7);assert.equal(fresh.frequency,2);assert.deepEqual(s.rangeMode(0,0,3),old);const n=s.versionCount;assert.throws(()=>s.applyBlock([{index:0,value:9},{index:5,value:9}]));assert.equal(s.versionCount,n);assert.equal(s.rangeMode(id,1,0),null);assert.ok(Object.isFrozen(s.version(0).toArray()));assert.deepEqual(fresh.positions,[0,1]);console.log('oldMode=1/2 newMode=7/2 rejectedBlockKeptVersion=true empty=null frozen=true');"

B 上述检查的完整执行输出以 JSON 字符串记录，解码后可还原完整原始输出："$ /usr/bin/node /home/delin/.local/share/gsb-workbench/artifacts/9df7badcaf504c79bd636c3be087397c/judge/pair/attempt-005/demonstration-B/demonstration/probe.mjs /home/delin/.local/share/gsb-workbench/artifacts/9df7badcaf504c79bd636c3be087397c/record/B/attempt-001/workspace\noldMode=1/2 newMode=7/2 rejectedBlockKeptVersion=true empty=null frozen=true\n"

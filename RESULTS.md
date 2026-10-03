# RESULTS

日期: 2026-10-03 10:19:13 CST  Node: v22.22.1

## 1. 全部测试（`node --test`）

```
TAP version 13
# Subtest: test/history.test.js
ok 1 - test/history.test.js
  ---
  duration_ms: 3305.941774
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3424.113125
```

## 2. 逐条验收（`node test/history.test.js`）

```
ok 1 - 全部拓扑序与 isAncestor 互相印证
ok 2 - 钻石并发合并产生确定性 head
ok 3 - 成环与缺父被拒绝
ok 4 - 删除非叶子报 ERR_CONFLICT，删叶子保留墓碑块
ok 5 - heads 与索引损坏时以事件图重建并报告
ok 6 - 相同内容不同 id 不自动合并
ok 7 - checkout 重建该 head 视角的更正序列
ok 8 - CLI：merge / heads / 错误 JSON
# tests 8
# suites 0
# pass 8
# fail 0
```

## 3. CLI 真实运行（`node cli.js ...`）

```console
$ node cli.js --dir $D init
{"ok":true,"dir":"/tmp/tmp.wbJpVeYQMF/history"}
$ node cli.js --dir $D append --author alice --payload v1
{"id":"416da61d6438dfbf0f33bd5e915b0e2b8109442e963f2b9491e4b0d2f730100d","heads":["416da61d6438dfbf0f33bd5e915b0e2b8109442e963f2b9491e4b0d2f730100d"]}
$ node cli.js --dir $D append --author bob --payload v2-left --parents $ROOT
{"id":"d102e12f7fbb46ae438aa9b0ac3dfce875253da2d20dda2bcf3d8515e1466895","heads":["d102e12f7fbb46ae438aa9b0ac3dfce875253da2d20dda2bcf3d8515e1466895"]}
$ node cli.js --dir $D append --author carol --payload v2-right --parents $ROOT
{"id":"768d517f639b17529d04f8857470afcd78bb836135081f0b1f666b0fb1d67bb9","heads":["768d517f639b17529d04f8857470afcd78bb836135081f0b1f666b0fb1d67bb9","d102e12f7fbb46ae438aa9b0ac3dfce875253da2d20dda2bcf3d8515e1466895"]}
$ node cli.js --dir $D heads   # 钻石两臂并发，两个 heads
{"heads":["768d517f639b17529d04f8857470afcd78bb836135081f0b1f666b0fb1d67bb9","d102e12f7fbb46ae438aa9b0ac3dfce875253da2d20dda2bcf3d8515e1466895"]}
$ node cli.js --dir $D merge $L $R
{"head":"5119ab0496a9f84445694215ee938cd0487bcf51c49eab42eb3c9c576c8abe7d","heads":["5119ab0496a9f84445694215ee938cd0487bcf51c49eab42eb3c9c576c8abe7d"]}
$ node cli.js --dir $D merge $R $L   # 顺序颠倒，head 相同（确定性）
{"head":"5119ab0496a9f84445694215ee938cd0487bcf51c49eab42eb3c9c576c8abe7d","heads":["5119ab0496a9f84445694215ee938cd0487bcf51c49eab42eb3c9c576c8abe7d"]}
$ node cli.js --dir $D is-ancestor $ROOT $L
{"isAncestor":true}
$ node cli.js --dir $D checkout $L
{"head":"d102e12f7fbb46ae438aa9b0ac3dfce875253da2d20dda2bcf3d8515e1466895","sequence":[{"id":"416da61d6438dfbf0f33bd5e915b0e2b8109442e963f2b9491e4b0d2f730100d","author":"alice","counter":1,"payload":"v1"},{"id":"d102e12f7fbb46ae438aa9b0ac3dfce875253da2d20dda2bcf3d8515e1466895","author":"bob","counter":1,"payload":"v2-left"}]}
$ node cli.js --dir $D remove $ROOT   # 非叶子，拒绝
{"error":"ERR_CONFLICT","message":"只能删除叶子 head；416da61d6438dfbf0f33bd5e915b0e2b8109442e963f2b9491e4b0d2f730100d 存在子事件"}
exit=1
$ cat $D/heads.json   # 破坏 heads 文件后重开
{"heads":["5119ab0496a9f84445694215ee938cd0487bcf51c49eab42eb3c9c576c8abe7d"]}
$ node cli.js --dir $D heads   # stderr 报告 REBUILT，按事件图重建
{"level":"warn","code":"REBUILT","rebuilt":["heads"],"message":"索引/heads 与事件图矛盾，已按事件图重建"}
{"heads":["5119ab0496a9f84445694215ee938cd0487bcf51c49eab42eb3c9c576c8abe7d"]}
```

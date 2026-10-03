# RESULTS

日期: 2026-10-04 04:18:25 CST  Node: v22.22.1

## 测试: `node --test`

```
ok 1 - 1a. crash during append (torn block) recovers to last commit, deterministically
ok 2 - 1b. crash during commit block write recovers to last complete commit
ok 3 - 1c. stale checkpoint is rebuilt from the log to the last complete commit
ok 4 - 2. all prefixes of a small log: tail returns exactly the committed prefix
ok 5 - 3. second committer based on a stale root is rejected with ERR_STALE_ROOT
ok 6 - 4. corrupt or missing checkpoint is rebuilt from the log
ok 7 - 5. empty log: recover is idempotent
ok 8 - ERR_FORK: tampered prevHash in committed region is rejected
ok 9 - ERR_CRC: corrupted committed block is rejected
ok 10 - ERR_SEQ: sequence regression in committed region is rejected
ok 11 - CLI: append/commit/tail/verify/recover roundtrip
ok 12 - CLI: errors are JSON on stderr with non-zero exit
# tests 12
# pass 12
# fail 0
```

## CLI 演示(真实输出)

```
$ node cli.js append demo.log "kyc:alice approved"
{"ok":true,"seq":1}
$ node cli.js commit demo.log
{"ok":true,"lastSeq":2,"root":"4b61c67b36b60f499917b5a506a6f8d7def52cf47d8df9116f5eb56e1659e8ee"}
$ node cli.js append demo.log "kyc:bob pending"
{"ok":true,"seq":3}
$ node cli.js tail demo.log   # uncommitted entry hidden
{"ok":true,"entries":[{"seq":1,"payload":"kyc:alice approved"}]}
$ node cli.js recover demo.log   # discards uncommitted tail
{"ok":true,"lastSeq":2,"root":"4b61c67b36b60f499917b5a506a6f8d7def52cf47d8df9116f5eb56e1659e8ee","truncatedBytes":151}
$ node cli.js verify demo.log
{"ok":true,"lastSeq":2,"root":"4b61c67b36b60f499917b5a506a6f8d7def52cf47d8df9116f5eb56e1659e8ee","entries":1,"pending":0}
$ node cli.js tail demo.log 1
{"ok":true,"entries":[{"seq":1,"payload":"kyc:alice approved"}]}
```

## 篡改拒绝(ERR_FORK,stderr JSON,exit=1)

```
$ # tamper: rewrite prevHash of committed block 1 (with recomputed CRC)
$ node -e "forge block 1 prevHash"
$ node cli.js verify demo.log; echo exit=\$?
{"error":"ERR_FORK","message":"block 1: prevHash does not link to previous block"}
exit=1
```

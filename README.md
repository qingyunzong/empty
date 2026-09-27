# lease — 单资源持久化租约 CLI

Python 3.11 标准库实现。状态（FREE/HELD/CANCELED/RELEASED）、单调 fence token
与操作日志持久化在状态目录（`--dir` 或 `$LEASE_DIR`，默认 `.lease`）。

## 命令

    python lease.py [--dir DIR] acquire KEY        # 同 KEY 租约有效时返回同一 token；新所有者获更大 token
    python lease.py [--dir DIR] write TOKEN OPID VALUE  # token 须等于当前 token；旧 token 退出码 9；同 TOKEN+OPID 幂等
    python lease.py [--dir DIR] cancel             # 标记 CANCELED，后续 write 拒绝（退出码 8）
    python lease.py [--dir DIR] renew              # 续租
    python lease.py [--dir DIR] release            # 逆序撤销本次预留效果，状态 RELEASED
    python lease.py [--dir DIR] crash --at {acquire,write,release}
    python lease.py [--dir DIR] recover            # 重放操作日志，按 KEY/OPID 去重
    python lease.py [--dir DIR] state              # 打印当前状态 JSON

退出码：0 成功；7 无有效租约；8 已取消；9 旧 token。
租约时长默认 30s，可用 `LEASE_TTL_SECONDS` 覆盖。

## 测试

    python -m unittest -v > result.txt 2>&1

真实运行结果见 `result.txt`（13 个测试全部通过）。

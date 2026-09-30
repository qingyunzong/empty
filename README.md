# tenantq

层级租户配额系统：资源预留（reserve）、确认（confirm）、释放（release）与幂等重试。
仅依赖 Python 3.11+ 标准库。

## 语义

- **reserve**：沿租户链（leaf → root）逐级检查 `quota - used - pending >= amount`，
  通过后逐级增加 `pending`。任一级不足（`E_QUOTA`）或缺失配额节点（`E_CONFIG`）时，
  所有已增加的 `pending` 精确回滚到操作前值。配额为 `0` 表示禁止。
- **confirm**：仅 `pending` 状态的预留可确认，沿链 `pending` 转 `used`；
  确认不存在或已失败/已确认/已释放的预留报 `E_STATE`，状态不静默变更。
- **release**：仅 `confirmed` 状态可释放，只减 `used`。
- **幂等**：成功的预留按 `idempotency_key` 缓存结果；同键同参重试返回原结果、
  不重复扣额；同键不同参报 `E_CONFLICT`。失败的预留记录为 `failed`（可审计、
  确认它报 `E_STATE`），但不缓存，修复后可用同键重试。

## 错误

所有领域错误为 `tenantq.PolicyError`，携带 `code`：
`E_QUOTA` / `E_CONFIG` / `E_STATE` / `E_CONFLICT` / `E_ARGS` / `E_NOTFOUND`。
CLI 遇到 `PolicyError` 输出 JSON 错误并以退出码 2 结束。

## CLI

状态持久化在 JSON 文件（默认 `./tenantq-state.json`，可用 `--db` 或
环境变量 `TENANTQ_DB` 覆盖）。每个命令输出 JSON 状态。

```bash
python -m tenantq init
python -m tenantq tenant add root
python -m tenantq tenant add leaf --parent root
python -m tenantq quota set root cpu 10
python -m tenantq quota set leaf cpu 4
python -m tenantq reserve leaf cpu 2 --key order-123
python -m tenantq confirm rsv-00000001
python -m tenantq release rsv-00000001
python -m tenantq status --tenant leaf
```

## 测试

```bash
python -m unittest discover -s tests -v
```

- `tests/test_acceptance.py`：验收 A（父级不足全链回滚）、B（同键幂等）、
  C（确认失败/不存在预留报 `E_STATE`）、D（零配额拒绝、缺失配额报 `E_CONFIG`）。
- `tests/test_cli.py`：CLI 生命周期与错误退出码。
- `tests/test_randomized_ledger.py`：验收 E —— 随机层级（深度 ≤ 5）、
  ≤ 1000 个随机操作（含失败注入），每个操作后与独立的事件溯源参考账本
  逐字段（tenants/reservations/keys/seq）深度对账。

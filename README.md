# downtime-policy-gate

工厂停机根因报告的发布前策略闸：按受众（操作员 / 供应商 / 总部）生成字段级视图，
防止配方与个人信息泄露。Node.js 22，仅标准库，测试使用 `node:test`。

## 使用

```sh
node src/cli.js --reports reports.jsonl --policy field-policy.json \
  --redactions redactions.jsonl --views views --audit leak-audit.jsonl
```

在 `fixtures/` 下有可直接运行的示例输入（参数默认值即这些文件名）。

## 输入

- `reports.jsonl`：每行 `{"id": "...", "fields": {...}}`。
- `field-policy.json`：
  - `classifications`：分类标签，可含 `minLevel`（`org`/`role`/`individual`）、
    `forced: true`（监管字段，强制可见）、`boundary: "null"`（未授权时置空）。
  - `fields`：字段 -> 分类。
  - `principals`：组织 -> 角色 -> 个人 的层级。
  - `grants`：按 `org` / `role` / `individual` 三级授权；权限沿层级向下继承，
    分类标签可强制升级所需授权级别（如 recipe 需要个人级授权）。
  - `audiences` / `joint`：生成哪些受众视图及交集视图的成员。
- `redactions.jsonl`：每行 `{"action":"revoke","audience":"...","field":"..."}`
  （`audience: "*"` 表示全部受众）。

## 输出

- `views/<report>.<audience>.<hash12>.view.json`：字段视图 + SHA-256 哈希 +
  输入指纹 + 状态。撤销共享后，旧视图保留哈希并标记 `expired`（仍可校验），
  新视图不含被撤字段。`joint` 视图取供应商与总部可见性的交集，监管字段例外强制可见。
- `leak-audit.jsonl`：每个活跃视图一行，校验每个输出字段都有授权路径；
  发现违规时给出使供应商视图泄露配方的最小字段集反例。

## 退出码

- `28`：未知分类（策略或报告字段引用了未定义的分类）
- `29`：视图哈希缺输入（已有视图找不到生成它的原始报告）
- `30`：监管字段被删除/撤销

## 测试

```sh
node --test
```

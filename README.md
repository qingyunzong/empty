# certchain

离线证书链支付授权库与 CLI。Node.js 22，仅标准库（`node:crypto` / `node:test`），无网络访问。

## 模型

- 每个主体持有 Ed25519 密钥对（`keygen`）。
- 证书由上级签发授权下级：`{ issuer, subject, maxAmount, notBefore, notAfter, id, signature }`。
  `id` 为证书体的 SHA-256，签名覆盖全部字段（含 `id`），篡改任一字段即验证失败。
- 自签证书只允许属于受信根（`add-root` 登记），否则报 `ERR_SELF_SIGNED_NON_ROOT`。
- `verify-payment` 枚举从受信根到付款人的所有简单授权链，要求链上每张证书：
  签名有效、根受信、未撤销、时间在 `[notBefore, notAfter]`、`maxAmount >= amount`。
  成功时返回 `{ rootId, chain, payment, chainHash, signature }`（付款人对付款动作签名）。
- `revoke` 产生撤销事件；`restore` 必须与撤销事件一一配对（未知或已恢复的撤销报错）。

## CLI（stdin/stdout NDJSON）

```sh
node src/cli.js
```

每行一个命令，每行一个响应（`{ok:true,...}` 或 `{ok:false,error:{code,message}}`）：

- `{"cmd":"keygen"}`
- `{"cmd":"add-root","rootId":"r1","publicKey":"..."}`
- `{"cmd":"issue-cert","issuerPrivateKey":"...","issuerPublicKey":"...","subjectPublicKey":"...","maxAmount":1000,"notBefore":0,"notAfter":1000000}`
- `{"cmd":"admit-cert","cert":{...}}`（接纳外部证书，验签在 verify-payment 时进行）
- `{"cmd":"revoke","certId":"..."}` → `{revokeId}`
- `{"cmd":"restore","revokeId":"..."}`
- `{"cmd":"verify-payment","payerPublicKey":"...","payerPrivateKey":"...","payee":"shop","amount":100,"time":500000}`

错误码：`ERR_SELF_SIGNED_NON_ROOT`、`ERR_UNKNOWN_ROOT`、`ERR_REVOKED`、`ERR_EXPIRED`、`ERR_AMOUNT_EXCEEDED`、`ERR_TAMPERED_SIGNATURE`、`ERR_UNKNOWN_CERT`、`ERR_UNKNOWN_REVOCATION`、`ERR_ALREADY_RESTORED`、`ERR_KEY_MISMATCH`、`ERR_BAD_INPUT`、`ERR_UNKNOWN_CMD`。

## 库

```js
import { Store, generateKeyPair, verifyCert } from './index.js';
```

## 测试

```sh
node --test
```

- `test/chain.test.js`：多级链、撤销/恢复、过期、超限、自签非根、未知根、逐字段篡改。
- `test/enumerate.test.js`：n≤7 随机授权图，与独立暴力枚举的全部简单链对照。
- `test/cli.test.js`：NDJSON 命令流端到端。

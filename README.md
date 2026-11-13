# 上传事务组件

可导入的 TypeScript 上传事务组件。文件选择、客户端校验、分片进度、服务端回执和页面附件行都使用同一个 `uploadId`；重试只处理尚未确认或服务端明确缺失的分片。

## 使用

```ts
import {
  createUploadTransaction,
  evidenceToJSON,
  type UploadTransport,
} from "dlks-de-0059";

const transport: UploadTransport = {
  async uploadChunk(request) {
    await fetch(`/api/uploads/${request.uploadId}/chunks/${request.chunkIndex}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-chunk-sha256": request.chunkDigest,
      },
      body: request.data,
    });
    return { uploadId: request.uploadId, chunkIndex: request.chunkIndex };
  },
  async complete(request) {
    const response = await fetch(`/api/uploads/${request.uploadId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return response.json();
  },
  async abort(uploadId) {
    await fetch(`/api/uploads/${uploadId}`, { method: "DELETE" });
  },
};

const uploads = createUploadTransaction({
  transport,
  chunkSize: 5 * 1024 * 1024,
  validation: {
    maxBytes: 200 * 1024 * 1024,
    allowedMimeTypes: ["application/pdf", "image/*"],
    allowedExtensions: ["pdf", "png", "jpg"],
  },
});

const selected = await uploads.selectFile(fileFromInput);
if (!selected.validation.valid) {
  console.log(selected.validation.issues);
  return;
}

try {
  await uploads.upload(selected.uploadId);
} catch {
  await uploads.retry(selected.uploadId);
}

await uploads.cancel(otherUploadId);

const evidence = uploads.getEvidence();
console.log(evidenceToJSON(evidence));
```

运行时没有可用的 `complete()` 时，组件会在所有分片确认后生成本地回执；生产适配器应实现服务端完成回执。服务端回执若携带不同的 `uploadId` 或 `contentDigest`，事务会失败且不会进入已提交集合。

## 事务规则

- `selectFile()` 读取字节、计算完整 SHA-256 和逐片 SHA-256，并创建唯一的 `uploadId`。
- `validation` 支持大小、MIME、扩展名和自定义异步校验；无效文件不会发送任何分片。
- `upload()` 只发送 `pending`/`failed` 分片；已确认分片在同一次或后续重试中不会重发。
- `retry()` 使用同一份分片清单，只补发未确认分片；若服务端回执列出 `missingChunks`，只补发这些分片。
- `cancel()` 使当前运行令牌失效。取消后才返回的分片或完成回执不会更新进度、不会写入回执，也不会进入 `committedUploadIds`。
- 页面附件行以 `uploadId` 作为 `id` 和 `uploadId`；同名文件按 `contentDigest` 保留为不同事务。
- `getEvidence()`/`getFinalEvidence()` 返回只包含可序列化数据的最终证据和一致性断言。

## 验证

```bash
npm test
```

测试覆盖同 id 绑定、客户端校验、缺片重试、服务端缺失分片重试、取消后的迟到分片/完成回执、同名文件摘要区分和回执 id 不匹配。

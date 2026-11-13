import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createUploadTransaction,
  evidenceToJSON,
  MissingChunksError,
  UploadCancelledError,
  UploadProtocolError,
  UploadValidationError,
} from "../dist/index.js";

class Deferred {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class MockTransport {
  constructor() {
    this.requests = [];
    this.completes = [];
    this.aborted = [];
    this.failOnce = new Set();
    this.missingOnComplete = null;
    this.receiptUploadId = null;
    this.chunkGates = new Map();
    this.chunkStarted = new Deferred();
    this.completeStarted = new Deferred();
    this.completeGate = null;
  }

  pauseChunk(index, gate) {
    this.chunkGates.set(index, gate);
  }

  pauseComplete(gate) {
    this.completeGate = gate;
  }

  async uploadChunk(request) {
    this.requests.push(request);
    const gate = this.chunkGates.get(request.chunkIndex);
    if (gate) {
      this.chunkStarted.resolve(request.chunkIndex);
      await gate.promise;
    }
    if (this.failOnce.delete(request.chunkIndex)) {
      throw new Error(`socket closed on chunk ${request.chunkIndex}`);
    }
    return {
      uploadId: request.uploadId,
      chunkIndex: request.chunkIndex,
      accepted: true,
    };
  }

  async complete(request) {
    this.completes.push(request);
    if (this.completeGate) {
      this.completeStarted.resolve();
      await this.completeGate.promise;
    }
    if (this.missingOnComplete) {
      const missingChunks = this.missingOnComplete;
      this.missingOnComplete = null;
      return {
        uploadId: request.uploadId,
        accepted: true,
        missingChunks,
      };
    }
    return {
      uploadId: this.receiptUploadId ?? request.uploadId,
      contentDigest: request.contentDigest,
      receiptId: `receipt-${request.uploadId}`,
      accepted: true,
    };
  }

  async abort(uploadId) {
    this.aborted.push(uploadId);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function file(data, name = "attachment.txt", type = "text/plain") {
  return { name, type, data };
}

test("binds one upload id across validation, chunks, receipt and attachment row", async () => {
  const transport = new MockTransport();
  const progressEvents = [];
  const rows = [];
  const component = createUploadTransaction({
    transport,
    chunkSize: 4,
    createUploadId: () => "upload-1",
    onProgress: (progress, snapshot) => {
      progressEvents.push({ progress, snapshot });
    },
    onAttachmentRow: (row) => {
      rows.push(row);
    },
  });

  const selected = await component.selectFile(file("abcdefghij"));
  assert.equal(selected.uploadId, "upload-1");
  assert.equal(selected.totalChunks, 3);
  assert.equal(selected.contentDigest, sha256("abcdefghij"));
  assert.equal(selected.validation.valid, true);
  assert.equal(selected.attachmentRow.id, "upload-1");
  assert.equal(selected.attachmentRow.uploadId, "upload-1");

  const committed = await component.upload(selected.uploadId);
  assert.equal(committed.status, "committed");
  assert.equal(committed.committed, true);
  assert.equal(committed.progress.percent, 100);
  assert.equal(committed.progress.acknowledgedChunks, 3);
  assert.equal(committed.serverReceipt.uploadId, "upload-1");
  assert.equal(committed.serverReceipt.contentDigest, sha256("abcdefghij"));
  assert.equal(committed.serverReceipt.receiptId, "receipt-upload-1");
  assert.equal(committed.attachmentRow.serverReceiptId, "receipt-upload-1");
  assert.equal(committed.attachmentRow.status, "committed");
  assert.equal(committed.attachmentRow.committed, true);

  assert.deepEqual(
    transport.requests.map((request) => request.uploadId),
    ["upload-1", "upload-1", "upload-1"],
  );
  assert.deepEqual(
    transport.requests.map((request) => request.chunkIndex),
    [0, 1, 2],
  );
  assert.ok(
    transport.requests.every(
      (request) =>
        request.digest.length === 64 && request.digest === request.chunkDigest,
    ),
  );
  assert.equal(transport.completes.length, 1);
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every(
      (row) => row.id === "upload-1" && row.uploadId === "upload-1",
    ),
  );
  assert.ok(
    progressEvents.every(
      ({ snapshot }) => snapshot.uploadId === "upload-1",
    ),
  );

  const evidence = component.getEvidence();
  assert.equal(evidence.schema, "upload-transaction-evidence/v1");
  assert.deepEqual(evidence.committedUploadIds, ["upload-1"]);
  assert.deepEqual(evidence.committedContentDigests, [sha256("abcdefghij")]);
  assert.equal(evidence.summary.committed, 1);
  assert.ok(Object.values(evidence.invariants).every(Boolean));
  assert.equal(JSON.stringify(evidence, null, 2), evidenceToJSON(evidence));
});

test("rejects invalid files before any chunk is sent", async () => {
  const transport = new MockTransport();
  const component = createUploadTransaction({
    transport,
    validation: { maxBytes: 5, allowedMimeTypes: ["text/*"] },
    createUploadId: () => "invalid-1",
  });
  const selected = await component.selectFile(file("123456"));

  assert.equal(selected.status, "invalid");
  assert.equal(selected.validation.valid, false);
  assert.equal(selected.attachmentRow.committed, false);
  assert.ok(
    selected.validation.issues.some((issue) => issue.code === "file_too_large"),
  );
  await assert.rejects(
    component.upload(selected.uploadId),
    UploadValidationError,
  );
  assert.equal(transport.requests.length, 0);
  assert.equal(component.isCommitted(selected.uploadId), false);
});

test("retry resends only the chunks that were not acknowledged", async () => {
  const transport = new MockTransport();
  transport.failOnce.add(1);
  const component = createUploadTransaction({
    transport,
    chunkSize: 4,
    createUploadId: () => "retry-1",
  });
  await component.selectFile(file("abcdefghijkl"));

  await assert.rejects(component.upload("retry-1"), /socket closed/);
  assert.deepEqual(
    transport.requests.map((request) => request.chunkIndex),
    [0, 1],
  );
  let snapshot = component.getSnapshot("retry-1");
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.chunks[0].status, "acknowledged");
  assert.equal(snapshot.chunks[1].status, "failed");
  assert.equal(snapshot.chunks[2].status, "pending");
  assert.equal(transport.completes.length, 0);

  snapshot = await component.retry("retry-1");
  assert.deepEqual(
    transport.requests.map((request) => request.chunkIndex),
    [0, 1, 1, 2],
  );
  assert.deepEqual(
    snapshot.chunks.map((chunk) => chunk.attempts),
    [1, 2, 1],
  );
  assert.equal(snapshot.status, "committed");
  assert.equal(transport.completes.length, 1);
});

test("server missing-chunk receipt limits retry to the reported chunks", async () => {
  const transport = new MockTransport();
  transport.missingOnComplete = [1];
  const component = createUploadTransaction({
    transport,
    chunkSize: 4,
    createUploadId: () => "missing-1",
  });
  await component.selectFile(file("abcdefghijkl"));

  await assert.rejects(
    component.upload("missing-1"),
    (error) => {
      assert.ok(error instanceof MissingChunksError);
      assert.deepEqual(error.missingChunks, [1]);
      return true;
    },
  );
  assert.equal(component.getSnapshot("missing-1").status, "failed");

  const committed = await component.retry("missing-1");
  assert.deepEqual(
    transport.requests.map((request) => request.chunkIndex),
    [0, 1, 2, 1],
  );
  assert.equal(committed.status, "committed");
  assert.equal(transport.completes.length, 2);
});

test("a chunk success that arrives after cancellation is ignored", async () => {
  const transport = new MockTransport();
  const gate = new Deferred();
  transport.pauseChunk(1, gate);
  const component = createUploadTransaction({
    transport,
    chunkSize: 4,
    createUploadId: () => "cancel-chunk-1",
  });
  await component.selectFile(file("abcdefgh"));

  const pendingUpload = component.upload("cancel-chunk-1");
  await transport.chunkStarted.promise;
  await component.cancel("cancel-chunk-1");
  assert.equal(component.getSnapshot("cancel-chunk-1").status, "cancelled");

  gate.resolve();
  await assert.rejects(pendingUpload, UploadCancelledError);

  const snapshot = component.getSnapshot("cancel-chunk-1");
  assert.equal(snapshot.cancelled, true);
  assert.equal(snapshot.committed, false);
  assert.equal(snapshot.lateSuccessesIgnored, 1);
  assert.equal(snapshot.chunks[1].status, "pending");
  assert.equal(component.isCommitted("cancel-chunk-1"), false);
  assert.equal(transport.completes.length, 0);

  const evidence = component.getEvidence();
  assert.deepEqual(evidence.committedUploadIds, []);
  assert.equal(evidence.summary.committed, 0);
  assert.equal(evidence.summary.lateSuccessesIgnored, 1);
  assert.equal(evidence.invariants.noCancelledUploadIsCommitted, true);
});

test("a completed server receipt that arrives after cancellation cannot commit", async () => {
  const transport = new MockTransport();
  const gate = new Deferred();
  transport.pauseComplete(gate);
  const component = createUploadTransaction({
    transport,
    createUploadId: () => "cancel-final-1",
  });
  await component.selectFile(file("abcdefgh"));

  const pendingUpload = component.upload("cancel-final-1");
  await transport.completeStarted.promise;
  await component.cancel("cancel-final-1");
  gate.resolve();
  await assert.rejects(pendingUpload, UploadCancelledError);

  const snapshot = component.getSnapshot("cancel-final-1");
  assert.equal(snapshot.status, "cancelled");
  assert.equal(snapshot.serverReceipt, null);
  assert.equal(snapshot.lateSuccessesIgnored, 1);
  assert.equal(component.isCommitted("cancel-final-1"), false);
  assert.deepEqual(component.committedUploadIds, []);
  assert.deepEqual(component.getEvidence().committedUploadIds, []);
});

test("same-name files remain separate by upload id and content digest", async () => {
  const transport = new MockTransport();
  const ids = ["same-name-a", "same-name-b"];
  const component = createUploadTransaction({
    transport,
    createUploadId: () => ids.shift(),
  });

  const first = await component.selectFile(file("first content", "report.txt"));
  const second = await component.selectFile(file("second content", "report.txt"));
  await component.upload(first.uploadId);
  await component.upload(second.uploadId);

  assert.notEqual(first.uploadId, second.uploadId);
  assert.notEqual(first.contentDigest, second.contentDigest);
  assert.equal(first.fileName, second.fileName);

  const rows = component.getAttachmentRowsByName("report.txt");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.uploadId),
    [first.uploadId, second.uploadId],
  );
  assert.deepEqual(
    rows.map((row) => row.contentDigest),
    [first.contentDigest, second.contentDigest],
  );
  assert.equal(component.getAttachmentRowsByDigest(first.contentDigest).length, 1);
  assert.equal(component.getAttachmentRowsByDigest(second.contentDigest).length, 1);
  assert.equal(component.committedUploadIds.length, 2);

  const evidence = component.getEvidence();
  assert.equal(new Set(evidence.committedContentDigests).size, 2);
  assert.equal(evidence.invariants.committedUploadIdsUnique, true);
});

test("a receipt for another upload id is rejected and never committed", async () => {
  const transport = new MockTransport();
  transport.receiptUploadId = "another-upload";
  const component = createUploadTransaction({
    transport,
    createUploadId: () => "protocol-1",
  });
  await component.selectFile(file("content"));

  await assert.rejects(component.upload("protocol-1"), UploadProtocolError);
  const snapshot = component.getSnapshot("protocol-1");
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.committed, false);
  assert.equal(snapshot.serverReceipt, null);
  assert.equal(component.isCommitted("protocol-1"), false);
});

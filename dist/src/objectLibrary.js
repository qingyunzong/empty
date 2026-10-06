"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectLibrary = exports.UploadSession = void 0;
const errors_1 = require("./errors");
let nextSessionSeq = 0;
/**
 * 一次受预留约束的上传会话。
 * 生命周期：open -> finished | cancelled，两个终态互斥，进入其一后另一个及自身均不可再达。
 */
class UploadSession {
    ledger;
    id;
    tenantId;
    objectKey;
    maxBytes;
    generation;
    stateValue = "open";
    publishedBytesValue = 0;
    constructor(ledger, options) {
        this.ledger = ledger;
        this.id = options.id;
        this.tenantId = options.tenantId;
        this.objectKey = options.objectKey;
        this.maxBytes = options.maxBytes;
        this.generation = options.generation ?? 0;
    }
    get state() {
        return this.stateValue;
    }
    get publishedBytes() {
        return this.publishedBytesValue;
    }
    get remainingBytes() {
        return this.maxBytes - this.publishedBytesValue;
    }
    /** 发布数据块；累计超过预留上限即拒绝，会话状态保持不变。 */
    publish(bytes) {
        this.assertOpen("publish");
        if (!Number.isSafeInteger(bytes) || bytes <= 0) {
            throw new RangeError(`publish bytes must be a positive safe integer, got ${bytes}`);
        }
        if (bytes > this.remainingBytes) {
            throw new errors_1.ReservationExceededError(`session ${this.id}: publishing ${bytes}B exceeds remaining reservation ` +
                `${this.remainingBytes}B (max=${this.maxBytes}B, published=${this.publishedBytesValue}B)`);
        }
        this.publishedBytesValue += bytes;
    }
    /** 结束：按实际发布量结算，未用预留归还租户额度。 */
    finish() {
        this.assertOpen("finish");
        this.ledger.settle(this.tenantId, this.maxBytes, this.publishedBytesValue);
        this.stateValue = "finished";
        return {
            sessionId: this.id,
            tenantId: this.tenantId,
            objectKey: this.objectKey,
            reservedBytes: this.maxBytes,
            committedBytes: this.publishedBytesValue,
            returnedBytes: this.maxBytes - this.publishedBytesValue,
        };
    }
    /** 取消：全部预留归还租户额度，已发布数据作废。 */
    cancel() {
        this.assertOpen("cancel");
        this.ledger.release(this.tenantId, this.maxBytes);
        this.stateValue = "cancelled";
    }
    assertOpen(op) {
        if (this.stateValue !== "open") {
            throw new errors_1.TerminalStateError(`session ${this.id}: cannot ${op} a ${this.stateValue} session ` +
                `(cancel 和 finish 只能进入一个终态)`);
        }
    }
}
exports.UploadSession = UploadSession;
/**
 * 对象库：上传开始前先按最大上传量预留租户额度，
 * 结束按实际发布量结算，取消全额归还；超预留的发布被拒绝。
 */
class ObjectLibrary {
    ledger;
    sessions = new Map();
    committed = [];
    constructor(ledger) {
        this.ledger = ledger;
    }
    /** 开启上传会话：先预留 maxBytes，预留不足则失败且不产生会话。 */
    beginUpload(options) {
        this.ledger.reserve(options.tenantId, options.maxBytes);
        const id = `upl-${++nextSessionSeq}`;
        const session = new UploadSession(this.ledger, { ...options, id });
        this.sessions.set(id, session);
        return session;
    }
    /** 结束会话并登记成品对象；等价于 session.finish()，由库记录结算结果。 */
    commit(session) {
        const receipt = session.finish();
        this.committed.push({
            objectKey: receipt.objectKey,
            tenantId: receipt.tenantId,
            bytes: receipt.committedBytes,
            sessionId: receipt.sessionId,
        });
        return receipt;
    }
    getSession(id) {
        return this.sessions.get(id);
    }
    committedObjects() {
        return this.committed;
    }
}
exports.ObjectLibrary = ObjectLibrary;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ControlledUploadAdapter = exports.UploadHandle = void 0;
const errors_1 = require("./errors");
/**
 * 受控上传句柄：绑定一个对象键的一个代际。
 * finish/cancel 幂等——额度对底层账本恰好归还一次；
 * 被新代际取代后（stale）写与结算被拒绝，取消为安全空操作。
 */
class UploadHandle {
    library;
    session;
    handleState = "open";
    stale = false;
    receipt;
    constructor(library, session) {
        this.library = library;
        this.session = session;
    }
    get tenantId() {
        return this.session.tenantId;
    }
    get objectKey() {
        return this.session.objectKey;
    }
    get generation() {
        return this.session.generation;
    }
    get state() {
        return this.handleState;
    }
    get isStale() {
        return this.stale;
    }
    write(bytes) {
        this.assertCurrent("write");
        this.assertOpen("write");
        this.session.publish(bytes);
    }
    /** 结束结算；重复调用返回同一回执，额度不会二次结算。 */
    finish() {
        this.assertCurrent("finish");
        if (this.handleState === "finished") {
            return this.receipt;
        }
        if (this.handleState === "cancelled") {
            throw new errors_1.TerminalStateError(`handle gen ${this.generation} for ${this.objectKey}: already cancelled, cannot finish (取消和结束只能一个终态)`);
        }
        this.receipt = this.library.commit(this.session);
        this.handleState = "finished";
        return this.receipt;
    }
    /** 取消；重复取消与被取代后的取消均为空操作，额度恰好归还一次。 */
    cancel() {
        if (this.handleState === "cancelled") {
            return;
        }
        if (this.handleState === "finished") {
            throw new errors_1.TerminalStateError(`handle gen ${this.generation} for ${this.objectKey}: already finished, cannot cancel (取消和结束只能一个终态)`);
        }
        this.session.cancel();
        this.handleState = "cancelled";
    }
    /** 由适配器在新代际开启时调用：取消旧代际，保证其预留恰好归还一次。 */
    supersede() {
        this.stale = true;
        this.cancel();
    }
    assertCurrent(op) {
        if (this.stale) {
            throw new errors_1.StaleGenerationError(`handle gen ${this.generation} for ${this.objectKey}: superseded by a newer generation, cannot ${op}`);
        }
    }
    assertOpen(op) {
        if (this.handleState !== "open") {
            throw new errors_1.TerminalStateError(`handle gen ${this.generation} for ${this.objectKey}: cannot ${op} a ${this.handleState} handle`);
        }
    }
}
exports.UploadHandle = UploadHandle;
/**
 * 受控上传适配器：按对象键管理上传代际。
 * 开启新代际时自动取消旧代际（旧代际取消），
 * 并通过句柄的幂等终态保证额度对账本恰好归还一次。
 */
class ControlledUploadAdapter {
    library;
    generations = new Map();
    active = new Map();
    constructor(library) {
        this.library = library;
    }
    /** 开启某对象键的新一代上传；旧代际（若仍打开）被取消且额度归还一次。 */
    start(tenantId, objectKey, maxBytes) {
        const key = ControlledUploadAdapter.keyOf(tenantId, objectKey);
        const generation = (this.generations.get(key) ?? 0) + 1;
        const previous = this.active.get(key);
        if (previous !== undefined) {
            previous.supersede();
        }
        const session = this.library.beginUpload({ tenantId, objectKey, maxBytes, generation });
        const handle = new UploadHandle(this.library, session);
        this.generations.set(key, generation);
        this.active.set(key, handle);
        return handle;
    }
    currentGeneration(tenantId, objectKey) {
        return this.generations.get(ControlledUploadAdapter.keyOf(tenantId, objectKey)) ?? 0;
    }
    activeHandle(tenantId, objectKey) {
        return this.active.get(ControlledUploadAdapter.keyOf(tenantId, objectKey));
    }
    static keyOf(tenantId, objectKey) {
        return `${tenantId}|${objectKey}`;
    }
}
exports.ControlledUploadAdapter = ControlledUploadAdapter;

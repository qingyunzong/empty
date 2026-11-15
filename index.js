/**
 * Debezium transaction reassembly.
 *
 * The reassembler buffers Debezium data events by transaction id and only
 * exposes a transaction after its END metadata has arrived and every event
 * ordinal declared by the metadata is present. It never emits a partial
 * transaction, including when a timeout is reported or state is restored
 * after a crash.
 */
export class TransactionReassemblyError extends Error {
    code;
    constructor(message, code = "ERR_TRANSACTION_REASSEMBLY") {
        super(message);
        this.name = "TransactionReassemblyError";
        this.code = code;
    }
}
export class DuplicateEventConflictError extends TransactionReassemblyError {
    transactionId;
    totalOrder;
    existingEvent;
    incomingEvent;
    existing;
    incoming;
    kind;
    constructor(transactionId, totalOrder, existingEvent, incomingEvent, kind = "data") {
        super(`Conflicting duplicate ${kind} for transaction ${transactionId}` +
            (totalOrder === null ? "" : ` at total_order ${totalOrder}`), "ERR_DUPLICATE_EVENT_CONFLICT");
        this.name = "DuplicateEventConflictError";
        this.transactionId = transactionId;
        this.totalOrder = totalOrder;
        this.existingEvent = existingEvent;
        this.incomingEvent = incomingEvent;
        this.existing = existingEvent;
        this.incoming = incomingEvent;
        this.kind = kind;
    }
}
export class InvalidTransactionMetadataError extends TransactionReassemblyError {
    metadata;
    constructor(message, metadata) {
        super(message, "ERR_INVALID_TRANSACTION_METADATA");
        this.name = "InvalidTransactionMetadataError";
        this.metadata = metadata;
    }
}
export class SnapshotError extends TransactionReassemblyError {
    constructor(message) {
        super(message, "ERR_INVALID_TRANSACTION_SNAPSHOT");
        this.name = "SnapshotError";
    }
}
const METADATA_STATUSES = new Map([
    ["BEGIN", "BEGIN"],
    ["START", "BEGIN"],
    ["STARTED", "BEGIN"],
    ["END", "END"],
    ["COMMIT", "END"],
    ["COMMITTED", "END"],
    ["ABORT", "ABORT"],
    ["ABORTED", "ABORT"],
    ["ROLLBACK", "ABORT"],
    ["ROLLED_BACK", "ABORT"],
]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toId(value) {
    if (typeof value === "string") {
        return value.length > 0 ? value : null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    return null;
}
function toOrder(value) {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === "bigint") {
        const converted = Number(value);
        return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
    }
    if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
        const converted = Number(value.trim());
        return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
    }
    return null;
}
function toCount(value) {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === "bigint") {
        const converted = Number(value);
        return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
    }
    if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
        const converted = Number(value.trim());
        return Number.isSafeInteger(converted) && converted >= 0 ? converted : null;
    }
    return null;
}
function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null) {
            return value;
        }
    }
    return undefined;
}
function stringValue(value) {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return null;
}
function asStatus(value) {
    if (typeof value !== "string") {
        return null;
    }
    return METADATA_STATUSES.get(value.trim().toUpperCase()) ?? null;
}
function ownStatus(record) {
    if (!record) {
        return null;
    }
    return asStatus(firstDefined(record.status, record.transaction_status, record.transactionStatus));
}
function metadataCandidates(input) {
    if (!isRecord(input)) {
        return [];
    }
    const candidates = [];
    const add = (value) => {
        if (isRecord(value) && !candidates.includes(value)) {
            candidates.push(value);
        }
    };
    add(input);
    add(input.value);
    add(input.payload);
    add(input.metadata);
    add(input.record);
    add(input.transaction);
    add(input.payload);
    if (isRecord(input.value)) {
        add(input.value.metadata);
        add(input.value.payload);
    }
    if (isRecord(input.metadata)) {
        add(input.metadata.value);
    }
    // Some fixtures wrap a transaction metadata event in after; only consider
    // that shape when the record is clearly from a transaction topic.
    const topic = stringValue(firstDefined(input.topic, isRecord(input.source) ? input.source.topic : undefined, isRecord(input.value)
        ? firstDefined(input.value.topic, isRecord(input.value.source) ? input.value.source.topic : undefined)
        : undefined));
    if (isRecord(input.after) &&
        (topic === null || topic.toLowerCase().includes("transaction"))) {
        add(input.after);
    }
    return candidates.filter((candidate) => ownStatus(candidate) !== null);
}
function metadataId(input, candidate) {
    const direct = firstDefined(candidate.id, candidate.transaction_id, candidate.transactionId, candidate.txid, candidate.txId, candidate.txn_id, candidate.txnId);
    const directId = toId(direct);
    if (directId !== null) {
        return directId;
    }
    if (isRecord(input.key)) {
        let keyId = toId(firstDefined(input.key.id, input.key.transaction_id, input.key.transactionId, input.key.txid, input.key.txId));
        if (keyId === null && isRecord(input.key.payload)) {
            keyId = toId(firstDefined(input.key.payload.id, input.key.payload.transaction_id, input.key.payload.transactionId));
        }
        if (keyId !== null) {
            return keyId;
        }
    }
    else {
        let keyValue = input.key;
        const BufferConstructor = globalThis.Buffer;
        if (BufferConstructor !== undefined &&
            typeof BufferConstructor.isBuffer === "function" &&
            BufferConstructor.isBuffer(keyValue)) {
            keyValue = keyValue.toString("utf8");
        }
        if (typeof keyValue === "string" &&
            keyValue.trim().startsWith("{")) {
            try {
                const parsedKey = JSON.parse(keyValue);
                if (isRecord(parsedKey)) {
                    keyValue =
                        firstDefined(parsedKey.id, parsedKey.transaction_id, parsedKey.transactionId) ?? keyValue;
                }
            }
            catch {
                // Not a JSON key; fall through to plain string handling.
            }
        }
        const keyId = toId(keyValue);
        if (keyId !== null) {
            return keyId;
        }
    }
    return toId(firstDefined(input.transaction_id, input.transactionId, input.txid, input.txId, input.txn_id, input.txnId));
}
function parseDataCollections(value) {
    if (value === undefined || value === null) {
        return [];
    }
    const results = [];
    const pushEntry = (entry) => {
        if (Array.isArray(entry) && entry.length >= 2) {
            const name = stringValue(entry[0]);
            const count = toCount(entry[1]);
            if (name !== null && count !== null) {
                results.push({ dataCollection: name, eventCount: count });
            }
            return;
        }
        if (isRecord(entry)) {
            const name = stringValue(firstDefined(entry.data_collection, entry.dataCollection, entry.collection, entry.name, entry.topic));
            const count = toCount(firstDefined(entry.event_count, entry.eventCount, entry.count, entry.events));
            if (name !== null && count !== null) {
                results.push({ dataCollection: name, eventCount: count });
            }
        }
    };
    if (Array.isArray(value)) {
        for (const entry of value) {
            pushEntry(entry);
        }
    }
    else if (isRecord(value)) {
        for (const [name, countValue] of Object.entries(value)) {
            const count = toCount(isRecord(countValue)
                ? firstDefined(countValue.event_count, countValue.eventCount, countValue.count)
                : countValue);
            if (count !== null) {
                results.push({ dataCollection: name, eventCount: count });
            }
        }
    }
    return results;
}
function parseMetadata(input, receivedAt) {
    const candidates = metadataCandidates(input);
    if (candidates.length === 0) {
        return null;
    }
    const candidate = candidates[0];
    const status = ownStatus(candidate);
    if (status === null) {
        return null;
    }
    const id = metadataId(input, candidate);
    if (id === null) {
        throw new InvalidTransactionMetadataError("Transaction metadata is missing the transaction id", input);
    }
    const rawCount = firstDefined(candidate.event_count, candidate.eventCount, candidate.total_events, candidate.totalEvents, candidate.events);
    const eventCount = toCount(rawCount);
    if (rawCount !== undefined && rawCount !== null && eventCount === null) {
        throw new InvalidTransactionMetadataError(`Invalid event_count for transaction ${id}`, input);
    }
    return {
        id,
        status,
        eventCount,
        dataCollections: parseDataCollections(firstDefined(candidate.data_collections, candidate.dataCollections, candidate.collections, candidate.topics)),
        receivedAt,
        raw: input,
        value: candidate,
    };
}
function transactionBlock(input) {
    if (!isRecord(input)) {
        return null;
    }
    const blocks = [
        input.transaction,
        isRecord(input.value) ? input.value.transaction : undefined,
        isRecord(input.value) && isRecord(input.value.payload)
            ? input.value.payload.transaction
            : undefined,
        isRecord(input.payload) ? input.payload.transaction : undefined,
        isRecord(input.after) ? input.after.transaction : undefined,
        isRecord(input.metadata) ? input.metadata.transaction : undefined,
    ];
    for (const block of blocks) {
        if (typeof block === "string" && block.length > 0) {
            return block;
        }
        if (isRecord(block)) {
            return block;
        }
    }
    return null;
}
function collectionFromSource(source) {
    const explicit = stringValue(firstDefined(source.data_collection, source.dataCollection, source.collection, source.topic));
    if (explicit !== null) {
        return explicit;
    }
    const schema = stringValue(source.schema);
    const table = stringValue(source.table);
    if (schema !== null && table !== null) {
        return `${schema}.${table}`;
    }
    return table;
}
function dataCollectionName(input) {
    if (!isRecord(input)) {
        return null;
    }
    const direct = stringValue(firstDefined(input.data_collection, input.dataCollection, isRecord(input.value)
        ? firstDefined(input.value.data_collection, input.value.dataCollection)
        : undefined, isRecord(input.payload)
        ? firstDefined(input.payload.data_collection, input.payload.dataCollection)
        : undefined, isRecord(input.value) && isRecord(input.value.payload)
        ? firstDefined(input.value.payload.data_collection, input.value.payload.dataCollection)
        : undefined));
    if (direct !== null) {
        return direct;
    }
    const sources = [
        isRecord(input.source) ? input.source : null,
        isRecord(input.value) && isRecord(input.value.source)
            ? input.value.source
            : null,
        isRecord(input.payload) && isRecord(input.payload.source)
            ? input.payload.source
            : null,
        isRecord(input.value) &&
            isRecord(input.value.payload) &&
            isRecord(input.value.payload.source)
            ? input.value.payload.source
            : null,
        isRecord(input.after) && isRecord(input.after.source)
            ? input.after.source
            : null,
        isRecord(input.payload) &&
            isRecord(input.payload.after) &&
            isRecord(input.payload.after.source)
            ? input.payload.after.source
            : null,
    ];
    for (const source of sources) {
        if (source) {
            const name = collectionFromSource(source);
            if (name !== null) {
                return name;
            }
        }
    }
    return stringValue(firstDefined(input.topic, isRecord(input.value) ? input.value.topic : undefined));
}
function parseDataEvent(input) {
    const block = transactionBlock(input);
    let transactionId = null;
    if (typeof block === "string") {
        transactionId = toId(block);
    }
    else if (isRecord(block)) {
        transactionId = toId(firstDefined(block.id, block.transaction_id, block.transactionId, block.txid, block.txId, block.txn_id, block.txnId));
    }
    if (transactionId === null && isRecord(input)) {
        transactionId = toId(firstDefined(input.transaction_id, input.transactionId, input.txid, input.txId, input.txn_id, input.txnId));
    }
    if (transactionId === null && isRecord(input)) {
        const sources = [
            isRecord(input.source) ? input.source : null,
            isRecord(input.value) && isRecord(input.value.source)
                ? input.value.source
                : null,
            isRecord(input.payload) && isRecord(input.payload.source)
                ? input.payload.source
                : null,
        ];
        for (const source of sources) {
            if (source) {
                transactionId = toId(firstDefined(source.transaction_id, source.transactionId, source.txId));
                if (transactionId !== null) {
                    break;
                }
            }
        }
    }
    const hasOrderField = isRecord(input) &&
        [
            "total_order",
            "totalOrder",
            "totalOrderId",
            "data_collection_order",
            "dataCollectionOrder",
        ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
    if (transactionId === null && hasOrderField && isRecord(input) && !ownStatus(input)) {
        transactionId = toId(input.id);
    }
    if (transactionId === null) {
        return null;
    }
    const readOrder = (...names) => {
        const sources = [
            isRecord(input) && isRecord(input.source) ? input.source : null,
            isRecord(input) && isRecord(input.value) && isRecord(input.value.source)
                ? input.value.source
                : null,
            isRecord(input) && isRecord(input.payload) && isRecord(input.payload.source)
                ? input.payload.source
                : null,
        ];
        for (const name of names) {
            if (isRecord(block) && block[name] !== undefined) {
                return block[name];
            }
            if (isRecord(input) && input[name] !== undefined) {
                return input[name];
            }
            for (const source of sources) {
                if (source && source[name] !== undefined) {
                    return source[name];
                }
            }
        }
        return undefined;
    };
    const totalOrder = toOrder(readOrder("total_order", "totalOrder", "totalOrderId", "total_order_id"));
    const dataCollectionOrder = toOrder(readOrder("data_collection_order", "dataCollectionOrder", "data_collection_order_id"));
    return {
        transactionId,
        totalOrder,
        dataCollectionOrder,
        dataCollection: dataCollectionName(input),
        topic: stringValue(firstDefined(isRecord(input) ? input.topic : undefined, isRecord(input) && isRecord(input.value) ? input.value.topic : undefined, isRecord(input) && isRecord(input.payload) ? input.payload.topic : undefined, isRecord(input) &&
            isRecord(input.value) &&
            isRecord(input.value.payload)
            ? input.value.payload.topic
            : undefined, isRecord(input) && isRecord(input.source) ? input.source.topic : undefined, isRecord(input) &&
            isRecord(input.payload) &&
            isRecord(input.payload.source)
            ? input.payload.source.topic
            : undefined, isRecord(input) && isRecord(input.value) && isRecord(input.value.source)
            ? input.value.source.topic
            : undefined)),
        partition: isRecord(input) && typeof input.partition === "number"
            ? input.partition
            : null,
        offset: isRecord(input) && typeof input.offset === "number" ? input.offset : null,
        event: input,
    };
}
function normalizeCollectionName(name) {
    return name.trim().toLowerCase().replace(/["'`\[\]]/g, "");
}
function collectionsMatch(eventCollection, metadataCollection) {
    if (eventCollection === null) {
        return false;
    }
    const eventName = normalizeCollectionName(eventCollection);
    const metaName = normalizeCollectionName(metadataCollection);
    if (eventName === metaName) {
        return true;
    }
    return eventName.endsWith(`.${metaName}`) || metaName.endsWith(`.${eventName}`);
}
function makeResult(batches, gaps = []) {
    const result = batches;
    Object.defineProperties(result, {
        batches: { value: result, enumerable: false },
        committed: { value: result, enumerable: false },
        transactions: { value: result, enumerable: false },
        gaps: { value: gaps, enumerable: false },
        batch: { get: () => (result.length > 0 ? result[0] : null), enumerable: false },
        first: { get: () => (result.length > 0 ? result[0] : null), enumerable: false },
        ready: { value: result, enumerable: false },
    });
    return result;
}
function makeGapResult(gaps) {
    const result = gaps;
    Object.defineProperty(result, "gaps", { value: result, enumerable: false });
    return result;
}
function defineAlias(target, name, getter) {
    Object.defineProperty(target, name, {
        get: getter,
        enumerable: false,
        configurable: true,
    });
}
function defineAliasIfAbsent(target, name, getter) {
    if (Object.prototype.hasOwnProperty.call(target, name)) {
        return;
    }
    defineAlias(target, name, getter);
}
function attachBatchAliases(batch) {
    defineAliasIfAbsent(batch, "id", () => batch.transactionId);
    defineAliasIfAbsent(batch, "txId", () => batch.transactionId);
    defineAliasIfAbsent(batch, "transaction_id", () => batch.transactionId);
    defineAliasIfAbsent(batch, "records", () => batch.events);
    defineAliasIfAbsent(batch, "data", () => batch.events);
    defineAliasIfAbsent(batch, "count", () => batch.eventCount);
    defineAliasIfAbsent(batch, "event_count", () => batch.eventCount);
    defineAliasIfAbsent(batch, "beginEvent", () => batch.begin);
    defineAliasIfAbsent(batch, "endEvent", () => batch.end);
    if (!batch.transactional) {
        defineAliasIfAbsent(batch, "event", () => batch.events[0]);
        defineAliasIfAbsent(batch, "record", () => batch.events[0]);
        defineAliasIfAbsent(batch, "value", () => batch.events[0]?.value);
        defineAliasIfAbsent(batch, "key", () => batch.events[0]?.key);
        defineAliasIfAbsent(batch, "topic", () => batch.events[0]?.topic);
        defineAliasIfAbsent(batch, "partition", () => batch.events[0]?.partition);
        defineAliasIfAbsent(batch, "offset", () => batch.events[0]?.offset);
    }
    return batch;
}
function attachGapAliases(gap) {
    defineAlias(gap, "id", () => gap.transactionId);
    defineAlias(gap, "missingOrders", () => gap.missingTotalOrders);
    defineAlias(gap, "missing_orders", () => gap.missingTotalOrders);
    defineAlias(gap, "missing_total_orders", () => gap.missingTotalOrders);
    defineAlias(gap, "missing", () => gap.missingTotalOrders);
    defineAlias(gap, "missingOrdinals", () => gap.missingTotalOrders);
    defineAlias(gap, "missing_data_collection_orders", () => gap.missingDataCollectionOrders);
    defineAlias(gap, "missingDataCollectionOrder", () => gap.missingDataCollectionOrders);
    defineAlias(gap, "missingByCollection", () => gap.missingDataCollectionOrders);
    defineAlias(gap, "missingSequenceNumbers", () => gap.missingTotalOrders);
    return gap;
}
function metadataToPlain(metadata) {
    if (metadata === null) {
        return null;
    }
    return {
        ...metadata.value,
        id: metadata.id,
        status: metadata.status,
        event_count: metadata.eventCount,
        eventCount: metadata.eventCount,
        data_collections: metadata.dataCollections.map((item) => ({
            data_collection: item.dataCollection,
            event_count: item.eventCount,
        })),
        dataCollections: metadata.dataCollections.map((item) => ({
            dataCollection: item.dataCollection,
            eventCount: item.eventCount,
        })),
        receivedAt: metadata.receivedAt,
        raw: metadata.raw,
    };
}
function createState(id, now) {
    return {
        id,
        begin: null,
        end: null,
        records: new Map(),
        unsequenced: [],
        conflict: false,
        conflictReason: null,
        createdAt: now,
        updatedAt: now,
        endOrder: Number.MAX_SAFE_INTEGER,
        duplicateCount: 0,
        completed: false,
        completedBatch: null,
        lastGapAt: null,
    };
}
/**
 * A small EventEmitter-compatible surface. Keeping it local means the library
 * has no runtime or compile-time dependency on @types/node.
 */
export class MiniEventEmitter {
    _listeners;
    constructor() {
        this._listeners = new Map();
    }
    on(event, listener) {
        const entries = this._listeners.get(event) ?? [];
        entries.push({ listener, once: false });
        this._listeners.set(event, entries);
        return this;
    }
    addListener(event, listener) {
        return this.on(event, listener);
    }
    prependListener(event, listener) {
        const entries = this._listeners.get(event) ?? [];
        entries.unshift({ listener, once: false });
        this._listeners.set(event, entries);
        return this;
    }
    once(event, listener) {
        const entries = this._listeners.get(event) ?? [];
        entries.push({ listener, once: true });
        this._listeners.set(event, entries);
        return this;
    }
    off(event, listener) {
        const entries = this._listeners.get(event);
        if (entries === undefined) {
            return this;
        }
        const index = entries.findIndex((entry) => entry.listener === listener);
        if (index >= 0) {
            entries.splice(index, 1);
        }
        if (entries.length === 0) {
            this._listeners.delete(event);
        }
        return this;
    }
    removeListener(event, listener) {
        return this.off(event, listener);
    }
    removeAllListeners(event) {
        if (event === undefined) {
            this._listeners.clear();
        }
        else {
            this._listeners.delete(event);
        }
        return this;
    }
    listeners(event) {
        return (this._listeners.get(event) ?? []).map((entry) => entry.listener);
    }
    listenerCount(event) {
        return (this._listeners.get(event) ?? []).length;
    }
    eventNames() {
        return [...this._listeners.keys()];
    }
    emit(event, ...args) {
        const entries = this._listeners.get(event);
        if (entries === undefined || entries.length === 0) {
            return false;
        }
        for (const entry of [...entries]) {
            if (entry.once) {
                this.off(event, entry.listener);
            }
            entry.listener(...args);
        }
        return true;
    }
}
function deepEqualValue(left, right, seen) {
    if (Object.is(left, right)) {
        return true;
    }
    if (typeof left === "number" && typeof right === "number") {
        return Number.isNaN(left) && Number.isNaN(right);
    }
    if (left === null ||
        right === null ||
        typeof left !== "object" ||
        typeof right !== "object") {
        return false;
    }
    const previous = seen.get(left);
    if (previous !== undefined) {
        return previous === right;
    }
    seen.set(left, right);
    if (left instanceof Date || right instanceof Date) {
        return (left instanceof Date &&
            right instanceof Date &&
            left.getTime() === right.getTime());
    }
    if (left instanceof RegExp || right instanceof RegExp) {
        return (left instanceof RegExp &&
            right instanceof RegExp &&
            left.source === right.source &&
            left.flags === right.flags);
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (!deepEqualValue(left[index], right[index], seen)) {
                return false;
            }
        }
        return true;
    }
    if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
        if (!ArrayBuffer.isView(left) ||
            !ArrayBuffer.isView(right) ||
            left.constructor !== right.constructor ||
            left.byteLength !== right.byteLength) {
            return false;
        }
        const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        for (let index = 0; index < leftBytes.length; index += 1) {
            if (leftBytes[index] !== rightBytes[index]) {
                return false;
            }
        }
        return true;
    }
    if (left instanceof Map || right instanceof Map) {
        if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) {
            return false;
        }
        for (const [key, value] of left) {
            if (!right.has(key) || !deepEqualValue(value, right.get(key), seen)) {
                return false;
            }
        }
        return true;
    }
    if (left instanceof Set || right instanceof Set) {
        if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) {
            return false;
        }
        for (const value of left) {
            if (!right.has(value)) {
                return false;
            }
        }
        return true;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) {
            return false;
        }
        if (!deepEqualValue(left[key], right[key], seen)) {
            return false;
        }
    }
    return true;
}
export function deepEqual(left, right) {
    return deepEqualValue(left, right, new Map());
}
function withoutTransportMetadata(event) {
    if (!isRecord(event)) {
        return event;
    }
    const { partition: _partition, offset: _offset, timestamp: _timestamp, headers: _headers, ...content } = event;
    return content;
}
function eventContentEqual(left, right) {
    return (deepEqual(left, right) ||
        deepEqual(withoutTransportMetadata(left), withoutTransportMetadata(right)));
}
function normalizeTimeoutArguments(first, second, fallback, now) {
    if (first === undefined || first === null) {
        return { timeoutMs: fallback, now };
    }
    if (first instanceof Date) {
        return { timeoutMs: fallback, now: first.getTime() };
    }
    if (typeof first === "number") {
        if (second !== undefined) {
            return { timeoutMs: first, now: second };
        }
        // Epoch timestamps are unambiguously absolute; smaller values are
        // interpreted as durations, matching the common checkTimeouts(ms) call.
        if (first >= 100_000_000_000) {
            return { timeoutMs: fallback, now: first };
        }
        return { timeoutMs: first, now };
    }
    if (isRecord(first)) {
        const timeout = toCount(firstDefined(first.timeoutMs, first.timeout, first.ms));
        const at = firstDefined(first.now, first.at);
        return {
            timeoutMs: timeout === null ? fallback : timeout,
            now: typeof at === "number" && Number.isFinite(at) ? at : now,
        };
    }
    return { timeoutMs: fallback, now };
}
export class TransactionReassembler extends MiniEventEmitter {
    timeoutMs;
    autoCommit;
    _clock;
    _maxDelivered;
    _transactions;
    _ready;
    _delivered;
    _aborted;
    _endSequence;
    _onCommit;
    _onGap;
    _onTimeout;
    _history;
    _maxHistory;
    lastRecovered;
    constructor(options = {}) {
        super();
        const normalizedOptions = typeof options === "number" ? { timeoutMs: options } : options;
        this.timeoutMs =
            normalizedOptions.transactionTimeoutMs ??
                normalizedOptions.transactionTimeout ??
                normalizedOptions.timeoutMs ??
                normalizedOptions.timeout ??
                normalizedOptions.idleTimeoutMs ??
                normalizedOptions.idleTimeout ??
                30_000;
        this.autoCommit = normalizedOptions.autoCommit !== false;
        this._clock =
            typeof normalizedOptions.now === "function"
                ? normalizedOptions.now
                : typeof normalizedOptions.now === "number"
                    ? (() => normalizedOptions.now)
                    : typeof normalizedOptions.clock === "function"
                        ? normalizedOptions.clock
                        : () => Date.now();
        this._maxDelivered =
            typeof normalizedOptions.maxDeliveredTransactionIds === "number" &&
                normalizedOptions.maxDeliveredTransactionIds >= 0
                ? Math.floor(normalizedOptions.maxDeliveredTransactionIds)
                : Number.POSITIVE_INFINITY;
        this._transactions = new Map();
        this._ready = [];
        this._delivered = new Set();
        this._aborted = new Set();
        this._endSequence = 0;
        this._onCommit =
            normalizedOptions.onCommit ??
                normalizedOptions.onTransaction ??
                normalizedOptions.onBatch ??
                null;
        this._onGap = normalizedOptions.onGap ?? null;
        this._onTimeout = normalizedOptions.onTimeout ?? null;
        this._maxHistory =
            typeof normalizedOptions.maxCommittedHistory === "number" &&
                normalizedOptions.maxCommittedHistory >= 0
                ? Math.floor(normalizedOptions.maxCommittedHistory)
                : 1000;
        this._history = [];
        this.lastRecovered = [];
    }
    get pendingCount() {
        return this._transactions.size;
    }
    get size() {
        return this._transactions.size;
    }
    get length() {
        return this._transactions.size;
    }
    get bufferedCount() {
        return this._transactions.size;
    }
    get deliveredCount() {
        return this._delivered.size;
    }
    get transactionIds() {
        return [...this._transactions.keys()];
    }
    get committedBatches() {
        return [...this._history];
    }
    get history() {
        return [...this._history];
    }
    ingest(input, second) {
        const { options, metadata: secondaryMetadata } = this._parseIngestArguments(second);
        const receivedAt = typeof options.receivedAt === "number" && Number.isFinite(options.receivedAt)
            ? options.receivedAt
            : typeof options.now === "number" && Number.isFinite(options.now)
                ? options.now
                : this._clock();
        const batches = [];
        const compositeMetadata = isRecord(input) &&
            (input.metadata !== undefined || input.transactionMetadata !== undefined)
            ? firstDefined(input.metadata, input.transactionMetadata)
            : undefined;
        const compositeData = isRecord(input) &&
            (input.dataEvent !== undefined ||
                input.data !== undefined ||
                input.event !== undefined)
            ? firstDefined(input.dataEvent, input.data, input.event)
            : undefined;
        if (compositeMetadata !== undefined &&
            compositeData !== undefined &&
            metadataCandidates(compositeMetadata).length > 0) {
            const data = parseDataEvent(compositeData);
            if (data === null) {
                batches.push(this._deliverNonTransactional(compositeData, receivedAt));
            }
            else {
                this._handleData(data, receivedAt, batches);
            }
            const parsed = parseMetadata(compositeMetadata, receivedAt);
            if (parsed !== null) {
                this._handleMetadata(parsed, batches);
            }
        }
        else if (metadataCandidates(input).length > 0) {
            this._handleMetadata(parseMetadata(input, receivedAt), batches);
        }
        else {
            const data = parseDataEvent(input);
            if (data === null) {
                batches.push(this._deliverNonTransactional(input, receivedAt));
            }
            else {
                this._handleData(data, receivedAt, batches);
            }
        }
        if (secondaryMetadata !== null && secondaryMetadata !== input) {
            const metadata = parseMetadata(secondaryMetadata, receivedAt);
            if (metadata !== null) {
                this._handleMetadata(metadata, batches);
            }
        }
        return this._result(batches);
    }
    push(input, second) {
        return this.ingest(input, second);
    }
    add(input, second) {
        return this.ingest(input, second);
    }
    accept(input, second) {
        return this.ingest(input, second);
    }
    consume(input, second) {
        return this.ingest(input, second);
    }
    handle(input, second) {
        return this.ingest(input, second);
    }
    record(input, second) {
        return this.ingest(input, second);
    }
    process(input, second) {
        return this.ingest(input, second);
    }
    enqueue(input, second) {
        return this.ingest(input, second);
    }
    feed(input, second) {
        return this.ingest(input, second);
    }
    receive(input, second) {
        return this.ingest(input, second);
    }
    apply(input, second) {
        return this.ingest(input, second);
    }
    ingestDataEvent(input, second) {
        return this.ingest(input, second);
    }
    handleDataEvent(input, second) {
        return this.ingest(input, second);
    }
    addDataEvent(input, second) {
        return this.ingest(input, second);
    }
    ingestTransactionMetadata(metadata) {
        const receivedAt = this._clock();
        const batches = [];
        const parsed = parseMetadata(metadata, receivedAt);
        if (parsed === null) {
            throw new InvalidTransactionMetadataError("Not a Debezium transaction metadata event", metadata);
        }
        this._handleMetadata(parsed, batches);
        return this._result(batches);
    }
    handleTransactionMetadata(metadata) {
        return this.ingestTransactionMetadata(metadata);
    }
    addMetadata(metadata) {
        return this.ingestTransactionMetadata(metadata);
    }
    consumeTransactionMetadata(metadata) {
        return this.ingestTransactionMetadata(metadata);
    }
    ingestMany(events, options = {}) {
        const batches = [];
        for (const entry of events) {
            if (Array.isArray(entry) &&
                entry.length === 2 &&
                metadataCandidates(entry[1]).length > 0) {
                batches.push(...this.ingest(entry[0], entry[1]));
            }
            else {
                batches.push(...this.ingest(entry, options));
            }
        }
        return this._result(batches);
    }
    pushMany(events, options = {}) {
        return this.ingestMany(events, options);
    }
    addMany(events, options = {}) {
        return this.ingestMany(events, options);
    }
    consumeAll(events, options = {}) {
        return this.ingestMany(events, options);
    }
    drain() {
        const batches = [];
        const ready = this._ready.splice(0);
        for (const state of ready) {
            if (state.completedBatch !== null && !this._delivered.has(state.id)) {
                this._deliver(state.completedBatch);
                this._transactions.delete(state.id);
                batches.push(state.completedBatch);
            }
        }
        return this._result(batches);
    }
    flush(first, second) {
        const batches = [...this.drain()];
        if (first === undefined) {
            return this._resultWithGaps(batches, this.reportGaps());
        }
        return this._resultWithGaps(batches, this.checkTimeouts(first, second));
    }
    commitReady() {
        return this.drain();
    }
    take() {
        return this.drain();
    }
    takeCommitted() {
        return this.drain();
    }
    getCommitted() {
        return this.drain();
    }
    getCommittedBatches() {
        return [...this._history];
    }
    getReadyBatches() {
        return this.drain();
    }
    poll() {
        while (this._ready.length > 0) {
            const state = this._ready.shift();
            if (state.completedBatch !== null && !this._delivered.has(state.id)) {
                const batch = state.completedBatch;
                this._deliver(batch);
                this._transactions.delete(state.id);
                return batch;
            }
        }
        return null;
    }
    _result(batches) {
        return this._resultWithGaps(batches, this.reportGaps());
    }
    _resultWithGaps(batches, gaps) {
        const result = makeResult(batches, gaps);
        defineAlias(result, "pending", () => this.pendingTransactions());
        defineAlias(result, "reassembler", () => this);
        defineAlias(result, "pendingCount", () => this.pendingCount);
        return result;
    }
    reportGaps(options = {}) {
        let now;
        if (options instanceof Date) {
            now = options.getTime();
        }
        else if (typeof options === "number" && Number.isFinite(options)) {
            now = options;
        }
        else {
            const timeoutOptions = options;
            now =
                typeof timeoutOptions.now === "number" &&
                    Number.isFinite(timeoutOptions.now)
                    ? timeoutOptions.now
                    : typeof timeoutOptions.at === "number" &&
                        Number.isFinite(timeoutOptions.at)
                        ? timeoutOptions.at
                        : this._clock();
        }
        const gaps = [];
        for (const state of this._transactions.values()) {
            if (state.completed || this._delivered.has(state.id)) {
                continue;
            }
            gaps.push(this._gapFor(state, now, false));
        }
        return makeGapResult(gaps);
    }
    gaps(options = {}) {
        return this.reportGaps(options);
    }
    getGaps(options = {}) {
        return this.reportGaps(options);
    }
    checkTimeouts(first, second) {
        const configured = normalizeTimeoutArguments(first, second, this.timeoutMs, this._clock());
        const timeoutMs = configured.timeoutMs;
        const now = configured.now;
        const gaps = [];
        for (const state of this._transactions.values()) {
            if (state.completed || this._delivered.has(state.id)) {
                continue;
            }
            if (now - state.updatedAt < timeoutMs) {
                continue;
            }
            const gap = this._gapFor(state, now, true);
            gaps.push(gap);
            this._notifyGap(gap, true);
        }
        if (gaps.length > 0) {
            this.emit("gaps", gaps);
        }
        return makeGapResult(gaps);
    }
    checkTimeoutsAt(now, timeoutMs = this.timeoutMs) {
        return this.checkTimeouts(timeoutMs, now);
    }
    expire(first, second) {
        return this.checkTimeouts(first, second);
    }
    timeout(first, second) {
        return this.checkTimeouts(first, second);
    }
    reportTimeouts(first, second) {
        return this.checkTimeouts(first, second);
    }
    expireTransactions(first, second) {
        return this.checkTimeouts(first, second);
    }
    snapshot() {
        return {
            version: 1,
            savedAt: this._clock(),
            endSequence: this._endSequence,
            delivered: [...this._delivered],
            aborted: [...this._aborted],
            transactions: [...this._transactions.values()].map((state) => this._serializeState(state)),
        };
    }
    serialize() {
        return JSON.stringify(this.snapshot());
    }
    save() {
        return this.serialize();
    }
    dump() {
        return this.snapshot();
    }
    toJSON() {
        return this.snapshot();
    }
    restore(snapshot) {
        let parsed = snapshot;
        if (typeof parsed === "string") {
            try {
                parsed = JSON.parse(parsed);
            }
            catch (error) {
                throw new SnapshotError(`Unable to parse transaction snapshot: ${error.message}`);
            }
        }
        if (!isRecord(parsed) || !Array.isArray(parsed.transactions)) {
            throw new SnapshotError("Invalid transaction snapshot");
        }
        if (parsed.version !== undefined && parsed.version !== 1) {
            throw new SnapshotError(`Unsupported transaction snapshot version: ${String(parsed.version)}`);
        }
        this._transactions.clear();
        this._ready.length = 0;
        this._delivered = new Set(Array.isArray(parsed.delivered)
            ? parsed.delivered.filter((id) => typeof id === "string")
            : []);
        this._aborted = new Set(Array.isArray(parsed.aborted)
            ? parsed.aborted.filter((id) => typeof id === "string")
            : []);
        this._endSequence =
            typeof parsed.endSequence === "number" &&
                Number.isSafeInteger(parsed.endSequence)
                ? parsed.endSequence
                : 0;
        for (const rawState of parsed.transactions) {
            const state = this._deserializeState(rawState);
            if (state === null || this._delivered.has(state.id)) {
                continue;
            }
            this._transactions.set(state.id, state);
        }
        const recovered = [];
        const ordered = [...this._transactions.values()].sort((a, b) => {
            if (a.endOrder !== b.endOrder) {
                return a.endOrder - b.endOrder;
            }
            return a.createdAt - b.createdAt;
        });
        for (const state of ordered) {
            if (state.end === null || state.completed) {
                if (state.completed && state.completedBatch !== null) {
                    const batch = state.completedBatch;
                    if (!this._delivered.has(state.id)) {
                        this._deliver(batch);
                        this._transactions.delete(state.id);
                        recovered.push(batch);
                    }
                }
                continue;
            }
            const produced = [];
            const batch = this._tryComplete(state, produced);
            if (batch !== null && !this._delivered.has(state.id)) {
                // Recovery is an explicit publish operation, even when autoCommit is
                // disabled. Restored state is still only published after validation
                // proves the transaction is complete.
                this._deliver(batch);
                this._transactions.delete(state.id);
                const readyIndex = this._ready.indexOf(state);
                if (readyIndex >= 0) {
                    this._ready.splice(readyIndex, 1);
                }
            }
            if (batch !== null) {
                if (!recovered.includes(batch)) {
                    recovered.push(batch);
                }
            }
        }
        this.lastRecovered = recovered;
        return this._result(recovered);
    }
    recover(snapshot) {
        return this.restore(snapshot);
    }
    loadSnapshot(snapshot) {
        return this.restore(snapshot);
    }
    load(snapshot) {
        return this.restore(snapshot);
    }
    hydrate(snapshot) {
        return this.restore(snapshot);
    }
    restoreFrom(snapshot) {
        return this.restore(snapshot);
    }
    pendingTransactions() {
        return [...this._transactions.values()].map((state) => ({
            transactionId: state.id,
            eventCount: state.records.size,
            expectedEventCount: state.end !== null
                ? state.end.eventCount
                : state.begin !== null
                    ? state.begin.eventCount
                    : null,
            complete: state.completed,
            conflict: state.conflict,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
        }));
    }
    getOpenTransactions() {
        return this.pendingTransactions();
    }
    getPendingTransactions() {
        return this.pendingTransactions();
    }
    getPending() {
        return this.pendingTransactions();
    }
    getOpen() {
        return this.pendingTransactions();
    }
    getBufferedTransactions() {
        return this.pendingTransactions();
    }
    getBuffered() {
        return this.pendingTransactions();
    }
    getTransaction(transactionId) {
        return (this.pendingTransactions().find((transaction) => transaction.transactionId === transactionId) ?? null);
    }
    hasTransaction(transactionId) {
        return this._transactions.has(transactionId);
    }
    removeTransaction(transactionId) {
        const removed = this._transactions.delete(transactionId);
        const readyIndex = this._ready.findIndex((state) => state.id === transactionId);
        if (readyIndex >= 0) {
            this._ready.splice(readyIndex, 1);
        }
        return removed;
    }
    stats() {
        return {
            openTransactions: this._transactions.size,
            readyTransactions: this._ready.length,
            deliveredTransactions: this._delivered.size,
            abortedTransactions: this._aborted.size,
        };
    }
    clear() {
        this._transactions.clear();
        this._ready.length = 0;
        this._delivered.clear();
        this._aborted.clear();
        this._endSequence = 0;
        this._history.length = 0;
        this.lastRecovered = [];
    }
    reset() {
        this.clear();
    }
    static fromSnapshot(snapshot, options = {}) {
        const reassembler = new TransactionReassembler(options);
        reassembler.restore(snapshot);
        return reassembler;
    }
    static fromJSON(snapshot, options = {}) {
        return TransactionReassembler.fromSnapshot(snapshot, options);
    }
    static restore(snapshot, options = {}) {
        return TransactionReassembler.fromSnapshot(snapshot, options);
    }
    static recover(snapshot, options = {}) {
        return TransactionReassembler.fromSnapshot(snapshot, options);
    }
    static fromEvents(events, options = {}) {
        const reassembler = new TransactionReassembler(options);
        reassembler.ingestMany(events);
        return reassembler;
    }
    _parseIngestArguments(second) {
        if (second === undefined || second === null) {
            return { options: {}, metadata: null };
        }
        if (typeof second === "number" && Number.isFinite(second)) {
            return { options: { receivedAt: second }, metadata: null };
        }
        if (second instanceof Date) {
            return { options: { receivedAt: second.getTime() }, metadata: null };
        }
        if (isRecord(second) &&
            ownStatus(second) === null &&
            !(isRecord(second.value) && ownStatus(second.value) !== null) &&
            (second.metadata !== undefined ||
                second.transactionMetadata !== undefined ||
                second.receivedAt !== undefined ||
                second.at !== undefined ||
                second.now !== undefined)) {
            const options = { ...second };
            const metadata = second.metadata !== undefined &&
                metadataCandidates(second.metadata).length > 0
                ? second.metadata
                : second.transactionMetadata !== undefined &&
                    metadataCandidates(second.transactionMetadata).length > 0
                    ? second.transactionMetadata
                    : null;
            return { options, metadata };
        }
        if (metadataCandidates(second).length > 0) {
            return { options: {}, metadata: second };
        }
        if (isRecord(second)) {
            const options = { ...second };
            const metadata = second.metadata !== undefined &&
                metadataCandidates(second.metadata).length > 0
                ? second.metadata
                : second.transactionMetadata !== undefined &&
                    metadataCandidates(second.transactionMetadata).length > 0
                    ? second.transactionMetadata
                    : null;
            return { options, metadata };
        }
        return { options: {}, metadata: null };
    }
    _handleMetadata(metadata, batches) {
        if (this._delivered.has(metadata.id)) {
            this._checkDeliveredMetadata(metadata);
            return;
        }
        if (this._aborted.has(metadata.id)) {
            return;
        }
        if (metadata.status === "ABORT") {
            this._transactions.delete(metadata.id);
            this._aborted.add(metadata.id);
            this.emit("abort", metadata);
            this.emit("aborted", metadata);
            return;
        }
        const state = this._transactions.get(metadata.id) ??
            createState(metadata.id, metadata.receivedAt);
        this._transactions.set(metadata.id, state);
        if (metadata.status === "BEGIN") {
            if (state.begin === null) {
                state.begin = metadata;
            }
            else {
                // A repeated BEGIN is the same boundary; keep the first one rather
                // than inventing a new ordering.
                state.duplicateCount += 1;
            }
            state.updatedAt = Math.max(state.updatedAt, metadata.receivedAt);
            return;
        }
        if (state.end === null) {
            state.end = metadata;
            state.endOrder = ++this._endSequence;
            state.updatedAt = Math.max(state.updatedAt, metadata.receivedAt);
            this._tryComplete(state, batches);
            return;
        }
        if (this._metadataEqual(state.end, metadata)) {
            state.duplicateCount += 1;
            state.updatedAt = Math.max(state.updatedAt, metadata.receivedAt);
            this._tryComplete(state, batches);
            return;
        }
        state.conflict = true;
        state.conflictReason = "Conflicting END metadata for the same transaction";
        state.updatedAt = Math.max(state.updatedAt, metadata.receivedAt);
        throw new DuplicateEventConflictError(state.id, null, state.end.raw, metadata.raw, "transaction metadata");
    }
    _checkDeliveredMetadata(metadata) {
        if (metadata.status !== "END") {
            return;
        }
        for (let index = this._history.length - 1; index >= 0; index -= 1) {
            const batch = this._history[index];
            if (!batch.transactional ||
                batch.transactionId !== metadata.id ||
                batch.end === null) {
                continue;
            }
            const expectedCount = toCount(firstDefined(batch.end.eventCount, batch.end.event_count));
            const expectedCollections = parseDataCollections(firstDefined(batch.end.dataCollections, batch.end.data_collections));
            const countMatches = metadata.eventCount === null ||
                expectedCount === null ||
                metadata.eventCount === expectedCount;
            const collectionsMatch = metadata.dataCollections.length === 0 ||
                expectedCollections.length === 0 ||
                deepEqual(metadata.dataCollections, expectedCollections);
            if (!countMatches || !collectionsMatch) {
                throw new DuplicateEventConflictError(metadata.id, null, batch.end, metadata.raw, "transaction metadata");
            }
            return;
        }
    }
    _handleData(data, receivedAt, batches) {
        if (this._delivered.has(data.transactionId)) {
            this._checkDeliveredDuplicate(data);
            return;
        }
        if (this._aborted.has(data.transactionId)) {
            return;
        }
        const state = this._transactions.get(data.transactionId) ??
            createState(data.transactionId, receivedAt);
        this._transactions.set(data.transactionId, state);
        const stored = {
            totalOrder: data.totalOrder ?? -1,
            dataCollectionOrder: data.dataCollectionOrder,
            dataCollection: data.dataCollection,
            topic: data.topic,
            partition: data.partition,
            offset: data.offset,
            event: data.event,
            receivedAt,
        };
        if (data.totalOrder === null) {
            state.unsequenced.push(stored);
            state.updatedAt = Math.max(state.updatedAt, receivedAt);
            return;
        }
        const existing = state.records.get(data.totalOrder);
        if (existing !== undefined) {
            if (eventContentEqual(existing.event, stored.event)) {
                state.duplicateCount += 1;
                state.updatedAt = Math.max(state.updatedAt, receivedAt);
                return;
            }
            state.conflict = true;
            state.conflictReason = `Conflicting duplicate at total_order ${data.totalOrder}`;
            state.updatedAt = Math.max(state.updatedAt, receivedAt);
            throw new DuplicateEventConflictError(state.id, data.totalOrder, existing.event, stored.event);
        }
        state.records.set(data.totalOrder, stored);
        state.updatedAt = Math.max(state.updatedAt, receivedAt);
        this._tryComplete(state, batches);
    }
    _checkDeliveredDuplicate(data) {
        if (data.totalOrder === null) {
            return;
        }
        for (let index = this._history.length - 1; index >= 0; index -= 1) {
            const batch = this._history[index];
            if (!batch.transactional ||
                batch.transactionId !== data.transactionId) {
                continue;
            }
            for (const event of batch.events) {
                const parsed = parseDataEvent(event);
                if (parsed === null || parsed.totalOrder !== data.totalOrder) {
                    continue;
                }
                if (!eventContentEqual(event, data.event)) {
                    throw new DuplicateEventConflictError(data.transactionId, data.totalOrder, event, data.event);
                }
                return;
            }
            return;
        }
    }
    _deliverNonTransactional(input, receivedAt) {
        const collection = dataCollectionName(input);
        const batch = isRecord(input)
            ? Object.assign({}, input)
            : {};
        Object.defineProperties(batch, {
            transactionId: { value: null, enumerable: false },
            events: { value: [input], enumerable: false },
            eventCount: { value: 1, enumerable: false },
            transactional: { value: false, enumerable: false },
            complete: { value: true, enumerable: false },
            begin: { value: null, enumerable: false },
            end: { value: null, enumerable: false },
            metadata: { value: { begin: null, end: null }, enumerable: false },
            dataCollections: {
                value: [{ dataCollection: collection, eventCount: 1 }],
                enumerable: false,
            },
            collections: {
                value: [{ dataCollection: collection, eventCount: 1 }],
                enumerable: false,
            },
            duplicateCount: { value: 0, enumerable: false },
            committedAt: { value: receivedAt, enumerable: false },
        });
        attachBatchAliases(batch);
        this._deliver(batch);
        return batch;
    }
    _tryComplete(state, batches) {
        if (state.completed && state.completedBatch !== null) {
            return null;
        }
        if (state.end === null || state.conflict) {
            return null;
        }
        const validation = this._validate(state);
        if (!validation.ok) {
            return null;
        }
        const sortedRecords = [...state.records.values()].sort((a, b) => a.totalOrder - b.totalOrder ||
            (a.dataCollectionOrder ?? Number.MAX_SAFE_INTEGER) -
                (b.dataCollectionOrder ?? Number.MAX_SAFE_INTEGER) ||
            (a.dataCollection ?? "").localeCompare(b.dataCollection ?? "") ||
            (a.partition ?? -1) - (b.partition ?? -1) ||
            (a.offset ?? -1) - (b.offset ?? -1));
        const events = sortedRecords.map((record) => record.event);
        const collectionCounts = new Map();
        for (const record of sortedRecords) {
            const name = record.dataCollection ?? "";
            collectionCounts.set(name, (collectionCounts.get(name) ?? 0) + 1);
        }
        const dataCollections = state.end.dataCollections.length > 0
            ? state.end.dataCollections.map((item) => ({
                dataCollection: item.dataCollection,
                eventCount: item.eventCount,
            }))
            : [...collectionCounts.entries()].map(([dataCollection, eventCount]) => ({ dataCollection, eventCount }));
        const committedAt = this._clock();
        const batch = {
            transactionId: state.id,
            events,
            eventCount: events.length,
            transactional: true,
            complete: true,
            begin: metadataToPlain(state.begin),
            end: metadataToPlain(state.end),
            metadata: {
                begin: metadataToPlain(state.begin),
                end: metadataToPlain(state.end),
            },
            dataCollections,
            collections: dataCollections,
            duplicateCount: state.duplicateCount,
            committedAt,
        };
        attachBatchAliases(batch);
        state.completed = true;
        state.completedBatch = batch;
        state.updatedAt = Math.max(state.updatedAt, committedAt);
        if (this.autoCommit) {
            this._deliver(batch);
            this._transactions.delete(state.id);
            batches.push(batch);
        }
        else {
            this._ready.push(state);
        }
        return batch;
    }
    _deliver(batch) {
        if (batch.transactional && this._delivered.has(batch.transactionId)) {
            return;
        }
        if (batch.transactional) {
            this._delivered.add(batch.transactionId);
            this._trimDelivered();
        }
        if (this._maxHistory > 0) {
            this._history.push(batch);
            if (this._history.length > this._maxHistory) {
                this._history.splice(0, this._history.length - this._maxHistory);
            }
        }
        this.emit("commit", batch);
        this.emit("committed", batch);
        this.emit("transaction", batch);
        this.emit("batch", batch);
        this.emit("data", batch);
        if (this._onCommit !== null) {
            this._onCommit(batch);
        }
    }
    _trimDelivered() {
        if (this._delivered.size <= this._maxDelivered) {
            return;
        }
        const excess = this._delivered.size - this._maxDelivered;
        let removed = 0;
        for (const id of this._delivered) {
            this._delivered.delete(id);
            removed += 1;
            if (removed >= excess) {
                break;
            }
        }
    }
    _validate(state) {
        const records = [...state.records.values()];
        const missingTotalOrders = [];
        const missingDataCollectionOrders = {};
        const missingCollections = [];
        if (state.conflict) {
            return {
                ok: false,
                reason: "conflict",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: state.end?.eventCount ?? null,
                details: state.conflictReason,
            };
        }
        if (state.end === null) {
            const maxOrder = records.reduce((maximum, record) => Math.max(maximum, record.totalOrder), 0);
            const base = state.records.has(0) ? 0 : 1;
            for (let order = base; order <= maxOrder; order += 1) {
                if (!state.records.has(order)) {
                    missingTotalOrders.push(order);
                }
            }
            if (state.unsequenced.length > 0) {
                return {
                    ok: false,
                    reason: "missing-sequence",
                    missingTotalOrders,
                    missingDataCollectionOrders,
                    missingCollections,
                    expectedEventCount: null,
                    details: "One or more data events have no total_order",
                };
            }
            return {
                ok: false,
                reason: missingTotalOrders.length > 0 ? "missing-total-order" : "missing-end",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: null,
                details: missingTotalOrders.length > 0
                    ? "Missing total_order values before END metadata"
                    : "Transaction END metadata has not arrived",
            };
        }
        if (state.unsequenced.length > 0) {
            return {
                ok: false,
                reason: "missing-sequence",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: state.end.eventCount,
                details: "One or more data events have no total_order",
            };
        }
        const beginTotal = state.begin !== null &&
            state.begin.eventCount !== null &&
            state.begin.eventCount > 0
            ? state.begin.eventCount
            : null;
        const declaredTotal = state.end.eventCount ?? beginTotal;
        const maxOrder = records.reduce((maximum, record) => Math.max(maximum, record.totalOrder), 0);
        const base = state.records.has(0) ? 0 : 1;
        const expectedTotal = declaredTotal === null ? Math.max(0, maxOrder - base + 1) : declaredTotal;
        for (let offset = 0; offset < expectedTotal; offset += 1) {
            const order = base + offset;
            if (!state.records.has(order)) {
                missingTotalOrders.push(order);
            }
        }
        const unexpected = records.filter((record) => record.totalOrder < base ||
            record.totalOrder >= base + expectedTotal);
        if (unexpected.length > 0) {
            return {
                ok: false,
                reason: "unexpected-event",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: expectedTotal,
                details: `Received total_order values beyond declared event_count ${expectedTotal}`,
            };
        }
        const declared = state.end.dataCollections;
        if (declared.length > 0) {
            const declaredNames = declared.map((item) => item.dataCollection);
            const declaredSum = declared.reduce((sum, item) => sum + item.eventCount, 0);
            if (declaredTotal !== null && declaredSum !== declaredTotal) {
                return {
                    ok: false,
                    reason: "invalid-metadata",
                    missingTotalOrders,
                    missingDataCollectionOrders,
                    missingCollections,
                    expectedEventCount: expectedTotal,
                    details: `data_collections event counts sum to ${declaredSum}, but event_count is ${declaredTotal}`,
                };
            }
            const unmatched = new Set(records);
            for (const collection of declared) {
                const matched = records.filter((record) => {
                    if (collectionsMatch(record.dataCollection, collection.dataCollection)) {
                        return true;
                    }
                    if (record.dataCollection === null &&
                        declaredNames.length === 1 &&
                        declaredNames[0] === collection.dataCollection) {
                        return true;
                    }
                    return false;
                });
                for (const record of matched) {
                    unmatched.delete(record);
                }
                if (matched.length === 0 && collection.eventCount > 0) {
                    missingCollections.push(collection.dataCollection);
                }
                const expectedOrders = collection.eventCount;
                if (expectedOrders > 0 && matched.length === 0) {
                    const missing = [];
                    for (let order = 1; order <= expectedOrders; order += 1) {
                        missing.push(order);
                    }
                    missingDataCollectionOrders[collection.dataCollection] = missing;
                    continue;
                }
                const seen = new Map();
                let hasMissingOrder = false;
                const duplicateOrders = [];
                for (const record of matched) {
                    if (record.dataCollectionOrder === null) {
                        hasMissingOrder = true;
                        continue;
                    }
                    const count = seen.get(record.dataCollectionOrder) ?? 0;
                    if (count > 0 && !duplicateOrders.includes(record.dataCollectionOrder)) {
                        duplicateOrders.push(record.dataCollectionOrder);
                    }
                    seen.set(record.dataCollectionOrder, count + 1);
                }
                const expectedOrdersForCollection = expectedOrders > 0 ? expectedOrders : matched.length;
                const uniqueOrders = [...seen.keys()].sort((a, b) => a - b);
                const missing = [...duplicateOrders];
                if (uniqueOrders.length > 0) {
                    for (let order = uniqueOrders[0]; order <= uniqueOrders[uniqueOrders.length - 1]; order += 1) {
                        if (!seen.has(order) && !missing.includes(order)) {
                            missing.push(order);
                        }
                    }
                }
                if (uniqueOrders.length !== expectedOrdersForCollection &&
                    uniqueOrders.length > 0) {
                    const minimum = uniqueOrders[0];
                    for (let order = minimum; order < minimum + expectedOrdersForCollection; order += 1) {
                        if (!seen.has(order) && !missing.includes(order)) {
                            missing.push(order);
                        }
                    }
                }
                if (hasMissingOrder ||
                    matched.length !== expectedOrdersForCollection ||
                    missing.length > 0) {
                    missingDataCollectionOrders[collection.dataCollection] = missing.sort((a, b) => a - b);
                }
            }
            if (unmatched.size > 0) {
                return {
                    ok: false,
                    reason: "invalid-metadata",
                    missingTotalOrders,
                    missingDataCollectionOrders,
                    missingCollections,
                    expectedEventCount: expectedTotal,
                    details: `Received events for collections not declared by END metadata: ${[
                        ...unmatched,
                    ]
                        .map((record) => record.dataCollection ?? "(unknown)")
                        .join(", ")}`,
                };
            }
        }
        else {
            // Without per-collection metadata, validate data_collection_order only
            // when the producer supplied it. Legacy fixtures that only carry
            // total_order remain valid, while partially sequenced events do not.
            const groups = new Map();
            for (const record of records) {
                const key = record.dataCollection ?? "";
                const group = groups.get(key) ?? [];
                group.push(record);
                groups.set(key, group);
            }
            for (const [name, group] of groups) {
                const anyOrdered = group.some((record) => record.dataCollectionOrder !== null);
                if (!anyOrdered) {
                    continue;
                }
                const seen = new Set();
                const missing = [];
                for (const record of group) {
                    if (record.dataCollectionOrder === null) {
                        if (!missing.includes(1)) {
                            missing.push(1);
                        }
                        continue;
                    }
                    if (seen.has(record.dataCollectionOrder)) {
                        if (!missing.includes(record.dataCollectionOrder)) {
                            missing.push(record.dataCollectionOrder);
                        }
                    }
                    seen.add(record.dataCollectionOrder);
                }
                const uniqueOrders = [...seen].sort((a, b) => a - b);
                if (uniqueOrders.length > 0) {
                    for (let order = uniqueOrders[0]; order <= uniqueOrders[uniqueOrders.length - 1]; order += 1) {
                        if (!seen.has(order) && !missing.includes(order)) {
                            missing.push(order);
                        }
                    }
                }
                if (uniqueOrders.length !== group.length) {
                    const minimum = uniqueOrders.length > 0 ? uniqueOrders[0] : 1;
                    for (let order = minimum; order < minimum + group.length; order += 1) {
                        if (!seen.has(order) && !missing.includes(order)) {
                            missing.push(order);
                        }
                    }
                }
                if (groups.size === 1 && uniqueOrders.length > 0 && uniqueOrders[0] > 1) {
                    for (let order = 1; order < uniqueOrders[0]; order += 1) {
                        if (!missing.includes(order)) {
                            missing.push(order);
                        }
                    }
                }
                if (missing.length > 0) {
                    missingDataCollectionOrders[name || "(unknown)"] = missing.sort((a, b) => a - b);
                }
            }
        }
        const hasCollectionGap = missingCollections.length > 0 ||
            Object.keys(missingDataCollectionOrders).length > 0;
        if (state.end.eventCount === 0 && records.length === 0) {
            return {
                ok: true,
                reason: "incomplete",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: 0,
                details: null,
            };
        }
        if (missingTotalOrders.length > 0) {
            return {
                ok: false,
                reason: "missing-total-order",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: expectedTotal,
                details: `Missing total_order ${missingTotalOrders.join(", ")}`,
            };
        }
        if (hasCollectionGap) {
            return {
                ok: false,
                reason: "missing-data-collection-order",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: expectedTotal,
                details: "Missing or inconsistent data_collection_order values",
            };
        }
        if (declaredTotal !== null && records.length !== declaredTotal) {
            return {
                ok: false,
                reason: "incomplete",
                missingTotalOrders,
                missingDataCollectionOrders,
                missingCollections,
                expectedEventCount: expectedTotal,
                details: `Received ${records.length} of ${declaredTotal} events`,
            };
        }
        return {
            ok: true,
            reason: "incomplete",
            missingTotalOrders,
            missingDataCollectionOrders,
            missingCollections,
            expectedEventCount: expectedTotal,
            details: null,
        };
    }
    _gapFor(state, now, timedOut) {
        const validation = this._validate(state);
        const gap = {
            transactionId: state.id,
            reason: state.conflict ? "conflict" : timedOut ? "timeout" : validation.reason,
            missingTotalOrders: validation.missingTotalOrders,
            missingDataCollectionOrders: validation.missingDataCollectionOrders,
            missingCollections: validation.missingCollections,
            expectedEventCount: validation.expectedEventCount,
            receivedEventCount: state.records.size,
            unsequencedEventCount: state.unsequenced.length,
            awaitingEnd: state.end === null,
            timedOut,
            conflict: state.conflict,
            cause: validation.reason,
            validationReason: validation.reason,
            ageMs: Math.max(0, now - state.updatedAt),
            lastUpdatedAt: state.updatedAt,
            details: validation.details,
        };
        attachGapAliases(gap);
        state.lastGapAt = now;
        return gap;
    }
    _notifyGap(gap, timeout) {
        this.emit("gap", gap);
        if (timeout) {
            this.emit("timeout", gap);
            if (this._onTimeout !== null) {
                this._onTimeout(gap);
            }
        }
        if (this._onGap !== null) {
            this._onGap(gap);
        }
    }
    _metadataEqual(left, right) {
        return (left.id === right.id &&
            left.status === right.status &&
            left.eventCount === right.eventCount &&
            deepEqual(left.dataCollections, right.dataCollections));
    }
    _serializeState(state) {
        return {
            id: state.id,
            begin: state.begin === null ? null : this._serializeMetadata(state.begin),
            end: state.end === null ? null : this._serializeMetadata(state.end),
            records: [...state.records.values()]
                .sort((a, b) => a.totalOrder - b.totalOrder)
                .map((record) => this._serializeRecord(record)),
            unsequenced: state.unsequenced.map((record) => this._serializeRecord(record)),
            conflict: state.conflict,
            conflictReason: state.conflictReason,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
            endOrder: state.endOrder,
            duplicateCount: state.duplicateCount,
            completed: state.completed,
        };
    }
    _serializeMetadata(metadata) {
        return {
            id: metadata.id,
            status: metadata.status,
            eventCount: metadata.eventCount,
            dataCollections: metadata.dataCollections,
            receivedAt: metadata.receivedAt,
            raw: metadata.raw,
            value: metadata.value,
        };
    }
    _serializeRecord(record) {
        return {
            totalOrder: record.totalOrder,
            dataCollectionOrder: record.dataCollectionOrder,
            dataCollection: record.dataCollection,
            topic: record.topic,
            partition: record.partition,
            offset: record.offset,
            event: record.event,
            receivedAt: record.receivedAt,
        };
    }
    _deserializeState(raw) {
        if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.records)) {
            throw new SnapshotError("Invalid transaction state in snapshot");
        }
        const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
            ? raw.createdAt
            : this._clock();
        const state = createState(raw.id, createdAt);
        state.updatedAt =
            typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
                ? raw.updatedAt
                : createdAt;
        state.endOrder =
            typeof raw.endOrder === "number" && Number.isFinite(raw.endOrder)
                ? raw.endOrder
                : Number.MAX_SAFE_INTEGER;
        state.duplicateCount =
            typeof raw.duplicateCount === "number" &&
                Number.isFinite(raw.duplicateCount)
                ? raw.duplicateCount
                : 0;
        state.conflict = raw.conflict === true;
        state.conflictReason =
            typeof raw.conflictReason === "string" ? raw.conflictReason : null;
        if (raw.begin !== null && raw.begin !== undefined) {
            state.begin = this._deserializeMetadata(raw.begin);
        }
        if (raw.end !== null && raw.end !== undefined) {
            state.end = this._deserializeMetadata(raw.end);
        }
        for (const rawRecord of raw.records) {
            const record = this._deserializeRecord(rawRecord);
            if (record.totalOrder < 0 || state.records.has(record.totalOrder)) {
                throw new SnapshotError(`Invalid or duplicate total_order in snapshot for transaction ${state.id}`);
            }
            state.records.set(record.totalOrder, record);
        }
        if (Array.isArray(raw.unsequenced)) {
            for (const rawRecord of raw.unsequenced) {
                state.unsequenced.push(this._deserializeRecord(rawRecord));
            }
        }
        return state;
    }
    _deserializeMetadata(raw) {
        if (!isRecord(raw) ||
            typeof raw.id !== "string" ||
            (raw.status !== "BEGIN" && raw.status !== "END" && raw.status !== "ABORT")) {
            throw new SnapshotError("Invalid transaction metadata in snapshot");
        }
        const dataCollections = Array.isArray(raw.dataCollections)
            ? raw.dataCollections
                .filter((item) => isRecord(item) &&
                typeof item.dataCollection === "string" &&
                typeof item.eventCount === "number")
                .map((item) => ({
                dataCollection: item.dataCollection,
                eventCount: item.eventCount,
            }))
            : [];
        const value = isRecord(raw.value) ? raw.value : {};
        return {
            id: raw.id,
            status: raw.status,
            eventCount: typeof raw.eventCount === "number" ? raw.eventCount : null,
            dataCollections,
            receivedAt: typeof raw.receivedAt === "number" && Number.isFinite(raw.receivedAt)
                ? raw.receivedAt
                : this._clock(),
            raw: raw.raw,
            value,
        };
    }
    _deserializeRecord(raw) {
        if (!isRecord(raw) ||
            typeof raw.totalOrder !== "number" ||
            !Number.isSafeInteger(raw.totalOrder)) {
            throw new SnapshotError("Invalid event record in snapshot");
        }
        return {
            totalOrder: raw.totalOrder,
            dataCollectionOrder: typeof raw.dataCollectionOrder === "number"
                ? raw.dataCollectionOrder
                : null,
            dataCollection: typeof raw.dataCollection === "string" ? raw.dataCollection : null,
            topic: typeof raw.topic === "string" ? raw.topic : null,
            partition: typeof raw.partition === "number" ? raw.partition : null,
            offset: typeof raw.offset === "number" ? raw.offset : null,
            event: raw.event,
            receivedAt: typeof raw.receivedAt === "number" && Number.isFinite(raw.receivedAt)
                ? raw.receivedAt
                : this._clock(),
        };
    }
}
export { TransactionReassembler as TransactionAssembler, TransactionReassembler as TransactionBuffer, TransactionReassembler as DebeziumTransactionReassembler, TransactionReassembler as DebeziumTransactionBuffer, TransactionReassembler as DebeziumTransactionAssembler, TransactionReassembler as TransactionComposer, TransactionReassembler as TransactionCommitBuffer, TransactionReassembler as TransactionReorganizationBuffer, TransactionReassembler as TransactionReassemblyBuffer, TransactionReassembler as TransactionBatchAssembler, TransactionReassembler as DebeziumTransactionCoordinator, TransactionReassembler as TransactionEngine, TransactionReassembler as DebeziumTransactionEngine, };
export const DuplicateConflictError = DuplicateEventConflictError;
export const TransactionOrderConflictError = DuplicateEventConflictError;
export const InvalidMetadataError = InvalidTransactionMetadataError;
export const InvalidSnapshotError = SnapshotError;
export function isTransactionMetadata(event) {
    return metadataCandidates(event).length > 0;
}
export const isTransactionMetadataEvent = isTransactionMetadata;
export const isMetadataEvent = isTransactionMetadata;
export function isTransactionalEvent(event) {
    return parseDataEvent(event) !== null;
}
export const isTransactionEvent = isTransactionalEvent;
export const hasTransactionMetadata = isTransactionalEvent;
export function createTransactionReassembler(options = {}) {
    return new TransactionReassembler(options);
}
export const createReassembler = createTransactionReassembler;
export const createTransactionBuffer = createTransactionReassembler;
export const createTransactionAssembler = createTransactionReassembler;
export function reassembleTransactions(events, options = {}) {
    const reassembler = new TransactionReassembler(options);
    const batches = [];
    for (const entry of events) {
        if (Array.isArray(entry) &&
            entry.length === 2 &&
            metadataCandidates(entry[1]).length > 0) {
            batches.push(...reassembler.ingest(entry[0], entry[1]));
        }
        else {
            batches.push(...reassembler.ingest(entry));
        }
    }
    const result = makeResult(batches, reassembler.reportGaps());
    defineAlias(result, "pending", () => reassembler.pendingTransactions());
    defineAlias(result, "reassembler", () => reassembler);
    defineAlias(result, "pendingCount", () => reassembler.pendingCount);
    return result;
}
export const reassemble = reassembleTransactions;
export const assembleTransactions = reassembleTransactions;
export const reassembleTransactionEvents = reassembleTransactions;
export const assembleTransactionEvents = reassembleTransactions;
export const groupTransactions = reassembleTransactions;
export default TransactionReassembler;

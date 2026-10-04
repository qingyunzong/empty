export class KittingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KittingError';
    this.code = code;
  }
}

export const STATUS_OK = 'OK';
export const STATUS_HOLD = 'HOLD';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fail(code, message) {
  throw new KittingError(code, message);
}

export class KittingEngine {
  constructor(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      fail('VALIDATION', 'input must be an object with batches/orders/substitutions arrays');
    }
    this.batches = new Map();
    this.orders = new Map();
    this.substitutions = new Map();
    this.undoStack = [];
    this.redoStack = [];
    const { batches = [], orders = [], substitutions = [] } = input;
    if (!Array.isArray(batches) || !Array.isArray(orders) || !Array.isArray(substitutions)) {
      fail('VALIDATION', 'batches, orders and substitutions must be arrays');
    }
    for (const raw of batches) this.#addBatch(raw);
    for (const raw of substitutions) this.#addSubstitution(raw);
    for (const raw of orders) this.#addOrder(raw);
  }

  static normalizeBatch(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('VALIDATION', 'batch must be an object');
    }
    const { batchId, materialId, qty, expiresAt, status = STATUS_OK } = raw;
    if (!isNonEmptyString(batchId)) fail('VALIDATION', 'batch.batchId must be a non-empty string');
    if (!isNonEmptyString(materialId)) fail('VALIDATION', `batch ${batchId}: materialId must be a non-empty string`);
    if (!isNonNegativeInt(qty)) fail('VALIDATION', `batch ${batchId}: qty must be a non-negative integer`);
    if (!isNonEmptyString(expiresAt)) fail('VALIDATION', `batch ${batchId}: expiresAt must be a non-empty string`);
    if (status !== STATUS_OK && status !== STATUS_HOLD) {
      fail('VALIDATION', `batch ${batchId}: status must be OK or HOLD`);
    }
    return { batchId, materialId, qty, expiresAt, status };
  }

  static normalizeOrder(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('VALIDATION', 'order must be an object');
    }
    const { orderId, dueDate, lines } = raw;
    if (!isNonEmptyString(orderId)) fail('VALIDATION', 'order.orderId must be a non-empty string');
    if (!isNonEmptyString(dueDate)) fail('VALIDATION', `order ${orderId}: dueDate must be a non-empty string`);
    if (!Array.isArray(lines) || lines.length === 0) {
      fail('VALIDATION', `order ${orderId}: lines must be a non-empty array`);
    }
    const seenLineIds = new Set();
    const normalizedLines = lines.map((line, index) => {
      if (line === null || typeof line !== 'object' || Array.isArray(line)) {
        fail('VALIDATION', `order ${orderId}: line ${index + 1} must be an object`);
      }
      const lineId = line.lineId ?? `L${index + 1}`;
      if (!isNonEmptyString(lineId)) fail('VALIDATION', `order ${orderId}: lineId must be a non-empty string`);
      if (seenLineIds.has(lineId)) fail('VALIDATION', `order ${orderId}: duplicate lineId ${lineId}`);
      seenLineIds.add(lineId);
      if (!isNonEmptyString(line.materialId)) {
        fail('VALIDATION', `order ${orderId} line ${lineId}: materialId must be a non-empty string`);
      }
      if (!isPositiveInt(line.qty)) {
        fail('VALIDATION', `order ${orderId} line ${lineId}: qty must be a positive integer`);
      }
      return { lineId, materialId: line.materialId, qty: line.qty };
    });
    return { orderId, dueDate, lines: normalizedLines };
  }

  #addBatch(raw) {
    const batch = KittingEngine.normalizeBatch(raw);
    if (this.batches.has(batch.batchId)) fail('DUPLICATE_BATCH', `duplicate batchId ${batch.batchId}`);
    this.batches.set(batch.batchId, batch);
  }

  #addOrder(raw) {
    const order = KittingEngine.normalizeOrder(raw);
    if (this.orders.has(order.orderId)) fail('DUPLICATE_ORDER', `duplicate orderId ${order.orderId}`);
    this.orders.set(order.orderId, order);
  }

  #removeOrder(orderId) {
    if (!isNonEmptyString(orderId)) fail('VALIDATION', 'removeOrder requires an orderId string');
    if (!this.orders.has(orderId)) fail('UNKNOWN_ORDER', `unknown order ${orderId}`);
    this.orders.delete(orderId);
  }

  #requireBatch(batchId) {
    if (!isNonEmptyString(batchId)) fail('VALIDATION', 'batchId must be a non-empty string');
    const batch = this.batches.get(batchId);
    if (!batch) fail('UNKNOWN_BATCH', `unknown batch ${batchId}`);
    return batch;
  }

  #setBatchStatus(batchId, status) {
    this.#requireBatch(batchId).status = status;
  }

  #consumeBatch(batchId, qty) {
    const batch = this.#requireBatch(batchId);
    if (!isPositiveInt(qty)) fail('VALIDATION', `consumeBatch for ${batchId}: qty must be a positive integer`);
    if (qty > batch.qty) {
      fail('OVER_CONSUME', `batch ${batchId}: cannot consume ${qty}, only ${batch.qty} on hand`);
    }
    batch.qty -= qty;
  }

  #addSubstitution(raw) {
    if (raw === null || typeof raw !== 'object') fail('VALIDATION', 'substitution must be an object');
    const { material, substitute } = raw;
    if (!isNonEmptyString(material) || !isNonEmptyString(substitute)) {
      fail('VALIDATION', 'substitution requires material and substitute strings');
    }
    if (material === substitute) {
      fail('CYCLE', `substitution ${material} -> ${substitute} is a self cycle`);
    }
    const edges = this.substitutions.get(material);
    if (edges && edges.has(substitute)) {
      fail('DUPLICATE_SUBSTITUTION', `substitution ${material} -> ${substitute} already exists`);
    }
    if (this.reachableMaterials(substitute).has(material)) {
      fail('CYCLE', `substitution ${material} -> ${substitute} would create a cycle`);
    }
    if (!this.substitutions.has(material)) this.substitutions.set(material, new Set());
    this.substitutions.get(material).add(substitute);
  }

  #removeSubstitution(raw) {
    if (raw === null || typeof raw !== 'object') fail('VALIDATION', 'substitution must be an object');
    const { material, substitute } = raw;
    const edges = this.substitutions.get(material);
    if (!edges || !edges.has(substitute)) {
      fail('UNKNOWN_SUBSTITUTION', `no substitution ${material} -> ${substitute}`);
    }
    edges.delete(substitute);
    if (edges.size === 0) this.substitutions.delete(material);
  }

  reachableMaterials(material) {
    const reached = new Set([material]);
    const queue = [material];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of this.substitutions.get(current) ?? []) {
        if (!reached.has(next)) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    return reached;
  }

  canServe(requiredMaterial, offeredMaterial) {
    return this.reachableMaterials(requiredMaterial).has(offeredMaterial);
  }

  #snapshot() {
    const substitutions = [];
    for (const [material, targets] of this.substitutions) {
      for (const substitute of targets) substitutions.push({ material, substitute });
    }
    return structuredClone({
      batches: [...this.batches.values()],
      orders: [...this.orders.values()],
      substitutions,
    });
  }

  #restore(snapshot) {
    this.batches = new Map(snapshot.batches.map((batch) => [batch.batchId, batch]));
    this.orders = new Map(snapshot.orders.map((order) => [order.orderId, order]));
    this.substitutions = new Map();
    for (const { material, substitute } of snapshot.substitutions) {
      if (!this.substitutions.has(material)) this.substitutions.set(material, new Set());
      this.substitutions.get(material).add(substitute);
    }
  }

  applyCommand(command) {
    if (command === null || typeof command !== 'object' || Array.isArray(command)) {
      fail('VALIDATION', 'command must be an object with an op field');
    }
    const { op } = command;
    if (op === 'undo') return this.undo();
    if (op === 'redo') return this.redo();
    const mutators = {
      addOrder: () => this.#addOrder(command.order),
      removeOrder: () => this.#removeOrder(command.orderId),
      addBatch: () => this.#addBatch(command.batch),
      holdBatch: () => this.#setBatchStatus(command.batchId, STATUS_HOLD),
      releaseBatch: () => this.#setBatchStatus(command.batchId, STATUS_OK),
      consumeBatch: () => this.#consumeBatch(command.batchId, command.qty),
      addSubstitution: () => this.#addSubstitution(command),
      removeSubstitution: () => this.#removeSubstitution(command),
    };
    const mutate = mutators[op];
    if (!mutate) fail('UNKNOWN_COMMAND', `unknown command op: ${String(op)}`);
    const snapshot = this.#snapshot();
    this.undoStack.push(snapshot);
    this.redoStack = [];
    try {
      mutate();
    } catch (error) {
      this.undoStack.pop();
      this.#restore(snapshot);
      throw error;
    }
    return { op, applied: true };
  }

  undo() {
    if (this.undoStack.length === 0) fail('EMPTY_UNDO', 'nothing to undo');
    this.redoStack.push(this.#snapshot());
    this.#restore(this.undoStack.pop());
    return { op: 'undo', applied: true };
  }

  redo() {
    if (this.redoStack.length === 0) fail('EMPTY_REDO', 'nothing to redo');
    this.undoStack.push(this.#snapshot());
    this.#restore(this.redoStack.pop());
    return { op: 'redo', applied: true };
  }

  allocate() {
    const remaining = new Map();
    for (const [batchId, batch] of this.batches) remaining.set(batchId, batch.qty);
    const usableBatches = [...this.batches.values()].filter((batch) => batch.status === STATUS_OK);
    const sortedOrders = [...this.orders.values()].sort(
      (a, b) => compareStrings(a.dueDate, b.dueDate) || compareStrings(a.orderId, b.orderId),
    );
    const results = [];
    for (const order of sortedOrders) {
      const lineResults = [];
      for (const line of order.lines) {
        let need = line.qty;
        const reservations = [];
        const candidates = usableBatches
          .filter((batch) => remaining.get(batch.batchId) > 0 && this.canServe(line.materialId, batch.materialId))
          .sort((a, b) => compareStrings(a.expiresAt, b.expiresAt) || compareStrings(a.batchId, b.batchId));
        for (const batch of candidates) {
          if (need === 0) break;
          const take = Math.min(need, remaining.get(batch.batchId));
          if (take > 0) {
            reservations.push({ batchId: batch.batchId, qty: take });
            remaining.set(batch.batchId, remaining.get(batch.batchId) - take);
            need -= take;
          }
        }
        const lineResult = {
          lineId: line.lineId,
          materialId: line.materialId,
          qty: line.qty,
          reservations,
          reservedQty: line.qty - need,
          missing: need,
        };
        if (need > 0) {
          lineResult.substitutesTried = [...this.reachableMaterials(line.materialId)]
            .filter((material) => material !== line.materialId)
            .sort();
        }
        lineResults.push(lineResult);
      }
      results.push({
        orderId: order.orderId,
        dueDate: order.dueDate,
        status: lineResults.every((line) => line.missing === 0) ? 'OK' : 'SHORT',
        lines: lineResults,
      });
    }
    return results;
  }

  report() {
    const allocatedOrders = this.allocate();
    const reservedByBatch = new Map();
    for (const order of allocatedOrders) {
      for (const line of order.lines) {
        for (const reservation of line.reservations) {
          reservedByBatch.set(
            reservation.batchId,
            (reservedByBatch.get(reservation.batchId) ?? 0) + reservation.qty,
          );
        }
      }
    }
    const orders = allocatedOrders.map((order) => ({
      orderId: order.orderId,
      dueDate: order.dueDate,
      status: order.status,
      lines: order.lines.map((line) => ({
        lineId: line.lineId,
        materialId: line.materialId,
        qty: line.qty,
        reservedQty: line.reservedQty,
        missing: line.missing,
        reservations: line.reservations,
      })),
      shortages: order.lines
        .filter((line) => line.missing > 0)
        .map((line) => ({
          lineId: line.lineId,
          materialId: line.materialId,
          required: line.qty,
          reservedQty: line.reservedQty,
          missing: line.missing,
          substitutesTried: line.substitutesTried,
        })),
    }));
    const batches = [...this.batches.values()]
      .sort((a, b) => compareStrings(a.batchId, b.batchId))
      .map((batch) => {
        const reservedQty = reservedByBatch.get(batch.batchId) ?? 0;
        return {
          batchId: batch.batchId,
          materialId: batch.materialId,
          qty: batch.qty,
          status: batch.status,
          expiresAt: batch.expiresAt,
          reservedQty,
          availableQty: batch.qty - reservedQty,
        };
      });
    return {
      orders,
      batches,
      summary: {
        totalOrders: orders.length,
        shortOrders: orders.filter((order) => order.status === 'SHORT').length,
        totalBatches: batches.length,
        heldBatches: batches.filter((batch) => batch.status === STATUS_HOLD).length,
      },
    };
  }
}

// 交易撤单 saga 核心库。
// 成交顺序: RESERVE -> FEE -> MATCH
// 补偿顺序(相反): UNDO_MATCH -> REFUND_FEE -> RELEASE_RESERVE

export const FILL_STEPS = Object.freeze(['RESERVE', 'FEE', 'MATCH']);
export const COMPENSATION_STEPS = Object.freeze([
  'UNDO_MATCH',
  'REFUND_FEE',
  'RELEASE_RESERVE',
]);

export class SagaError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SagaError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function createState() {
  return {
    ledger: { available: 0, reserved: 0, feesCollected: 0 },
    fills: {},
    matches: {},
    events: [],
    eventSeq: 0,
  };
}

function logEvent(state, type, fillId, step) {
  state.eventSeq += 1;
  state.events.push({ seq: state.eventSeq, type, fillId, step });
}

export function deposit(state, amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new SagaError('INVALID_AMOUNT', `invalid deposit amount: ${amount}`);
  }
  state.ledger.available += amount;
  logEvent(state, 'DEPOSIT', null, null);
  return { ...state.ledger };
}

export function executeFill(state, { id, amount, fee = 0, irreversible = false }) {
  if (!id) throw new SagaError('INVALID_FILL', 'fill id is required');
  if (state.fills[id]) throw new SagaError('DUPLICATE_FILL', `fill ${id} already exists`, { fillId: id });
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(fee) || fee < 0) {
    throw new SagaError('INVALID_FILL', `invalid amount/fee for fill ${id}`, { fillId: id });
  }
  if (state.ledger.available < amount + fee) {
    throw new SagaError('INSUFFICIENT_FUNDS', `insufficient funds for fill ${id}`, { fillId: id });
  }

  // 阶段 1: 占用准备金
  state.ledger.available -= amount;
  state.ledger.reserved += amount;
  logEvent(state, 'FILL_STEP', id, 'RESERVE');

  // 阶段 2: 扣除手续费
  state.ledger.available -= fee;
  state.ledger.feesCollected += fee;
  logEvent(state, 'FILL_STEP', id, 'FEE');

  // 阶段 3: 登记撮合结果
  state.matches[id] = { fillId: id, amount, fee };
  logEvent(state, 'FILL_STEP', id, 'MATCH');

  const fill = {
    id,
    amount,
    fee,
    irreversible: Boolean(irreversible),
    status: 'FILLED',
    comp: { UNDO_MATCH: 'PENDING', REFUND_FEE: 'PENDING', RELEASE_RESERVE: 'PENDING' },
    certificate: null,
  };
  state.fills[id] = fill;
  return fill;
}

function applyCompensation(state, fill, step) {
  switch (step) {
    case 'UNDO_MATCH':
      delete state.matches[fill.id];
      break;
    case 'REFUND_FEE':
      state.ledger.feesCollected -= fill.fee;
      state.ledger.available += fill.fee;
      break;
    case 'RELEASE_RESERVE':
      state.ledger.reserved -= fill.amount;
      state.ledger.available += fill.amount;
      break;
    default:
      throw new SagaError('UNKNOWN_STEP', `unknown compensation step: ${step}`, { step });
  }
}

function buildCertificate(fill) {
  return {
    certificateId: `CERT-${fill.id}`,
    fillId: fill.id,
    status: 'CANCELLED',
    steps: [...COMPENSATION_STEPS],
    acks: [...COMPENSATION_STEPS],
    refundedFee: fill.fee,
    releasedReserve: fill.amount,
  };
}

function maybeFinalize(state, fill) {
  if (fill.status !== 'CANCELLED' && COMPENSATION_STEPS.every((s) => fill.comp[s] === 'ACK')) {
    fill.status = 'CANCELLED';
    fill.certificate = buildCertificate(fill);
    logEvent(state, 'CANCELLED', fill.id, null);
  }
}

// 撤单。opts.failAt 用于注入某一分支的一次性失败(模拟下游故障)。
// 已 ACK 的分支幂等跳过,不会重复退款;失败分支保持 FAILED,重试从该分支继续。
export function cancelFill(state, id, opts = {}) {
  const fill = state.fills[id];
  if (!fill) throw new SagaError('FILL_NOT_FOUND', `fill ${id} not found`, { fillId: id });
  if (fill.irreversible) {
    // 不可撤销成交: 整体拒绝,不产生任何部分补偿
    throw new SagaError('IRREVERSIBLE_CONFLICT', `fill ${id} is marked irreversible`, { fillId: id });
  }
  if (fill.status === 'CANCELLED') return fill.certificate; // 重复撤单幂等

  fill.status = 'CANCELLING';
  logEvent(state, 'CANCEL_ATTEMPT', id, null);

  for (const step of COMPENSATION_STEPS) {
    if (fill.comp[step] === 'ACK') continue; // 已 ACK 分支幂等,绝不重复补偿
    if (opts.failAt === step) {
      fill.comp[step] = 'FAILED';
      logEvent(state, 'COMPENSATION_FAILED', id, step);
      throw new SagaError('COMPENSATION_FAILED', `compensation step ${step} failed for fill ${id}`, { fillId: id, step });
    }
    applyCompensation(state, fill, step);
    fill.comp[step] = 'ACK';
    logEvent(state, 'COMPENSATION_ACK', id, step);
  }

  maybeFinalize(state, fill);
  return fill.certificate;
}

// 显式 ACK 某一分支。重复 ACK 幂等,不产生多退。
export function acknowledge(state, id, step) {
  const fill = state.fills[id];
  if (!fill) throw new SagaError('FILL_NOT_FOUND', `fill ${id} not found`, { fillId: id });
  if (!COMPENSATION_STEPS.includes(step)) {
    throw new SagaError('UNKNOWN_STEP', `unknown compensation step: ${step}`, { step });
  }
  if (fill.comp[step] === 'ACK') {
    return { fillId: id, step, ack: true, duplicate: true };
  }
  applyCompensation(state, fill, step);
  fill.comp[step] = 'ACK';
  logEvent(state, 'COMPENSATION_ACK', id, step);
  maybeFinalize(state, fill);
  return { fillId: id, step, ack: true, duplicate: false };
}

export function snapshot(state, id = undefined) {
  if (id !== undefined) {
    const fill = state.fills[id];
    if (!fill) throw new SagaError('FILL_NOT_FOUND', `fill ${id} not found`, { fillId: id });
    return { fill, ledger: { ...state.ledger }, matched: Boolean(state.matches[id]) };
  }
  return {
    ledger: { ...state.ledger },
    fills: state.fills,
    matches: state.matches,
  };
}

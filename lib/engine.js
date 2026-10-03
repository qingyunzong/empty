import { BusinessError } from "./errors.js";

export function emptyState() {
  return { seq: 0, accounts: {}, positions: {}, trades: {} };
}

export function cloneState(state) {
  return structuredClone(state);
}

function account(state, name) {
  if (!state.accounts[name]) state.accounts[name] = { credit: 0, frozen: 0 };
  return state.accounts[name];
}

function addPosition(state, name, symbol, delta) {
  const book = (state.positions[name] ??= {});
  book[symbol] = (book[symbol] ?? 0) + delta;
  if (book[symbol] === 0) delete book[symbol];
  if (Object.keys(book).length === 0) delete state.positions[name];
}

function needString(rec, field) {
  if (typeof rec[field] !== "string" || rec[field].length === 0) {
    throw new BusinessError("INVALID_RECORD", `记录缺少字段 ${field}: ${JSON.stringify(rec)}`);
  }
  return rec[field];
}

function needPositiveInt(rec, field) {
  const v = rec[field];
  if (!Number.isInteger(v) || v <= 0) {
    throw new BusinessError("INVALID_RECORD", `字段 ${field} 必须为正整数: ${JSON.stringify(rec)}`);
  }
  return v;
}

export function applyRecord(state, rec) {
  if (!rec || typeof rec !== "object") {
    throw new BusinessError("INVALID_RECORD", `非法记录: ${JSON.stringify(rec)}`);
  }
  switch (rec.type) {
    case "credit": {
      const name = needString(rec, "account");
      const amount = needPositiveInt(rec, "amount");
      account(state, name).credit += amount;
      return;
    }
    case "trade": {
      const id = needString(rec, "id");
      const buyer = needString(rec, "buyer");
      const seller = needString(rec, "seller");
      const symbol = needString(rec, "symbol");
      const qty = needPositiveInt(rec, "qty");
      const price = needPositiveInt(rec, "price");
      if (state.trades[id]) {
        throw new BusinessError("DUPLICATE_TRADE", `交易 ${id} 已存在`);
      }
      const cost = qty * price;
      const buyerAcc = account(state, buyer);
      if (buyerAcc.credit < cost) {
        throw new BusinessError(
          "INSUFFICIENT_CREDIT",
          `买方 ${buyer} 可用授信 ${buyerAcc.credit} 不足以冻结 ${cost}`,
        );
      }
      buyerAcc.credit -= cost;
      buyerAcc.frozen += cost;
      account(state, seller);
      state.trades[id] = { id, buyer, seller, symbol, qty, price, filled: 0, status: "open" };
      return;
    }
    case "fill": {
      const id = needString(rec, "trade");
      const qty = needPositiveInt(rec, "qty");
      const trade = state.trades[id];
      if (!trade) throw new BusinessError("UNKNOWN_TRADE", `交易 ${id} 不存在`);
      if (trade.status === "cancelled") {
        throw new BusinessError("TRADE_CANCELLED", `交易 ${id} 已全额撤销, 拒绝成交`);
      }
      if (trade.status === "filled") {
        throw new BusinessError("TRADE_FILLED", `交易 ${id} 已全额成交`);
      }
      if (trade.filled + qty > trade.qty) {
        throw new BusinessError(
          "OVERFILL",
          `交易 ${id} 成交 ${trade.filled}+${qty} 超出委托 ${trade.qty}`,
        );
      }
      trade.filled += qty;
      addPosition(state, trade.buyer, trade.symbol, qty);
      addPosition(state, trade.seller, trade.symbol, -qty);
      account(state, trade.buyer).frozen -= qty * trade.price;
      if (trade.filled === trade.qty) trade.status = "filled";
      return;
    }
    case "cancel": {
      const id = needString(rec, "trade");
      const trade = state.trades[id];
      if (!trade) throw new BusinessError("UNKNOWN_TRADE", `交易 ${id} 不存在`);
      if (trade.status === "cancelled") {
        throw new BusinessError("ALREADY_CANCELLED", `交易 ${id} 已撤销`);
      }
      const buyerAcc = account(state, trade.buyer);
      const remaining = (trade.qty - trade.filled) * trade.price;
      buyerAcc.frozen -= remaining;
      buyerAcc.credit += remaining;
      if (trade.filled > 0) {
        addPosition(state, trade.buyer, trade.symbol, -trade.filled);
        addPosition(state, trade.seller, trade.symbol, trade.filled);
      }
      trade.status = "cancelled";
      return;
    }
    default:
      throw new BusinessError("INVALID_RECORD", `未知记录类型: ${JSON.stringify(rec)}`);
  }
}

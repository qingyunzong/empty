"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyAccount = emptyAccount;
exports.initialWorld = initialWorld;
function emptyAccount() {
    return { onHand: 0, held: 0, retained: 0, consumed: 0, lost: 0, reversed: 0 };
}
function initialWorld() {
    return { seq: 0, materials: {}, equipment: {}, orders: {}, plans: {}, ledger: [] };
}

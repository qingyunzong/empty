"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaleGenerationError = exports.TerminalStateError = exports.ReservationExceededError = exports.QuotaExceededError = void 0;
class QuotaExceededError extends Error {
    constructor(message) {
        super(message);
        this.name = "QuotaExceededError";
    }
}
exports.QuotaExceededError = QuotaExceededError;
class ReservationExceededError extends Error {
    constructor(message) {
        super(message);
        this.name = "ReservationExceededError";
    }
}
exports.ReservationExceededError = ReservationExceededError;
class TerminalStateError extends Error {
    constructor(message) {
        super(message);
        this.name = "TerminalStateError";
    }
}
exports.TerminalStateError = TerminalStateError;
class StaleGenerationError extends Error {
    constructor(message) {
        super(message);
        this.name = "StaleGenerationError";
    }
}
exports.StaleGenerationError = StaleGenerationError;

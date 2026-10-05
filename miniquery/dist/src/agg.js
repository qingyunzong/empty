/** Aggregate accumulators. NULL inputs are ignored (except count(*)). */
import { QueryError } from "./types.js";
import { isNumeric, totalCompare } from "./values.js";
export function makeAccumulator(spec) {
    switch (spec.fn) {
        case "count":
            return new CountAcc(spec.arg === "*");
        case "sum":
            return new SumAcc();
        case "min":
            return new MinMaxAcc(1);
        case "max":
            return new MinMaxAcc(-1);
        case "avg":
            return new AvgAcc();
    }
}
class CountAcc {
    star;
    n = 0n;
    constructor(star) {
        this.star = star;
    }
    add(v) {
        if (this.star || v !== null)
            this.n += 1n;
    }
    result() {
        return this.n;
    }
}
class SumAcc {
    intSum = 0n;
    floatSum = 0;
    seenInt = false;
    seenFloat = false;
    add(v) {
        if (v === null)
            return;
        if (typeof v === "bigint") {
            this.intSum += v;
            this.seenInt = true;
        }
        else if (typeof v === "number") {
            this.floatSum += v;
            this.seenFloat = true;
        }
        else {
            throw new QueryError(`sum() requires numeric input, got ${typeof v}`);
        }
    }
    result() {
        if (!this.seenInt && !this.seenFloat)
            return null;
        if (this.seenFloat)
            return this.floatSum + Number(this.intSum);
        return this.intSum;
    }
}
class MinMaxAcc {
    sign;
    best = null;
    constructor(sign) {
        this.sign = sign;
    }
    add(v) {
        if (v === null)
            return;
        if (this.best === null) {
            this.best = v;
            return;
        }
        if (isNumeric(v) !== isNumeric(this.best)) {
            throw new QueryError("min/max over mixed types");
        }
        if (this.sign * totalCompare(v, this.best) < 0)
            this.best = v;
    }
    result() {
        return this.best;
    }
}
class AvgAcc {
    intSum = 0n;
    floatSum = 0;
    n = 0n;
    seenFloat = false;
    add(v) {
        if (v === null)
            return;
        if (typeof v === "bigint") {
            this.intSum += v;
        }
        else if (typeof v === "number") {
            this.floatSum += v;
            this.seenFloat = true;
        }
        else {
            throw new QueryError(`avg() requires numeric input, got ${typeof v}`);
        }
        this.n += 1n;
    }
    result() {
        if (this.n === 0n)
            return null;
        const total = this.floatSum + Number(this.intSum);
        return total / Number(this.n);
    }
}

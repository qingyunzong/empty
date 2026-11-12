package qpackdec

import "errors"

// These bounds define the int64 arithmetic envelope used by every counter.
// All additions and subtractions are checked, so no counter can silently wrap.
const (
	minInt64 = -1 << 63
	maxInt64 = 1<<63 - 1
)

func addChecked(a, b int64) (int64, bool) {
	if b > 0 && a > maxInt64-b {
		return 0, false
	}
	if b < 0 && a < minInt64-b {
		return 0, false
	}
	return a + b, true
}

func subChecked(a, b int64) (int64, bool) {
	if b > 0 && a < minInt64+b {
		return 0, false
	}
	if b < 0 && a > maxInt64+b {
		return 0, false
	}
	return a - b, true
}

// mulChecked guards the few internal multiplications (K*2, floor*F).
func mulChecked(a, b int64) (int64, bool) {
	if a == 0 || b == 0 {
		return 0, true
	}
	result := a * b
	if result/a != b {
		return 0, false
	}
	return result, true
}

// requiredInsertCount recovers R from the encoded insert count E, the current
// total insert count I and max capacity M, using the exact specified rules:
//
//	K = floor(M/32), F = 2K
//	E == 0 -> R = 0
//	otherwise K > 0 and E <= F, then
//	V = I + K
//	R = floor(V/F)*F + E - 1
//	if R > V: error when R <= F, otherwise R -= F
//	R == 0 is finally rejected.
func requiredInsertCount(encoded, insertCount, maxCapacity int64) (int64, error) {
	if encoded < 0 {
		return 0, errors.New("encoded insert count must be non-negative")
	}
	if insertCount < 0 {
		return 0, errors.New("insert count must be non-negative")
	}
	if maxCapacity < 0 {
		return 0, errors.New("max capacity must be non-negative")
	}
	if encoded == 0 {
		return 0, nil
	}

	k := maxCapacity / 32
	if k == 0 {
		return 0, errors.New("non-zero encoded insert count requires a dynamic table (K > 0)")
	}
	fullRange, ok := mulChecked(k, 2)
	if !ok {
		return 0, errors.New("full range overflow")
	}
	if encoded > fullRange {
		return 0, errors.New("encoded insert count exceeds full range F")
	}

	window, ok := addChecked(insertCount, k)
	if !ok {
		return 0, errors.New("I + K overflow")
	}
	quotient := window / fullRange
	span, ok := mulChecked(quotient, fullRange)
	if !ok {
		return 0, errors.New("floor(V/F)*F overflow")
	}
	required, ok := addChecked(span, encoded)
	if !ok {
		return 0, errors.New("required insert count overflow")
	}
	required, ok = subChecked(required, 1)
	if !ok {
		return 0, errors.New("required insert count overflow")
	}

	if required > window {
		if required <= fullRange {
			return 0, errors.New("invalid encoded insert count: wrapped value unreachable")
		}
		required, ok = subChecked(required, fullRange)
		if !ok {
			return 0, errors.New("full range subtraction overflow")
		}
	}
	if required == 0 {
		return 0, errors.New("required insert count resolved to zero")
	}
	return required, nil
}

// computeBase recovers the base from R, sign S and non-negative delta.
// S == 0 -> R + Delta, S == 1 -> R - Delta - 1. A negative result is rejected.
func computeBase(required int64, sign int, delta int64) (int64, error) {
	if delta < 0 {
		return 0, errors.New("delta must be non-negative")
	}
	switch sign {
	case 0:
		value, ok := addChecked(required, delta)
		if !ok {
			return 0, errors.New("base arithmetic overflow")
		}
		if value < 0 {
			return 0, errors.New("negative base rejected")
		}
		return value, nil
	case 1:
		value, ok := subChecked(required, delta)
		if !ok {
			return 0, errors.New("base arithmetic overflow")
		}
		value, ok = subChecked(value, 1)
		if !ok {
			return 0, errors.New("base arithmetic overflow")
		}
		if value < 0 {
			return 0, errors.New("negative base rejected")
		}
		return value, nil
	default:
		return 0, errors.New("sign must be 0 or 1")
	}
}

// dynamicAbsolute maps a relative or post-base field onto an absolute index
// using checked arithmetic. Relative i -> Base-i-1, post-base i -> Base+i.
func dynamicAbsolute(base int64, f Field) (int64, error) {
	if f.Index < 0 {
		return 0, errors.New("field index must be non-negative")
	}
	switch f.Kind {
	case FieldRelative:
		value, ok := subChecked(base, f.Index)
		if !ok {
			return 0, errors.New("base arithmetic overflow")
		}
		value, ok = subChecked(value, 1)
		if !ok {
			return 0, errors.New("base arithmetic overflow")
		}
		return value, nil
	case FieldPostBase:
		value, ok := addChecked(base, f.Index)
		if !ok {
			return 0, errors.New("base arithmetic overflow")
		}
		return value, nil
	default:
		return 0, errors.New("not a dynamic field reference")
	}
}

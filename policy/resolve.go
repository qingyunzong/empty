package policy

import (
	"reflect"
	"strings"
)

// fieldState is the tri-state outcome of resolving a path.
type fieldState int

const (
	fieldMissing fieldState = iota // key absent somewhere along the path
	fieldNull                      // present, explicitly null
	fieldValue                     // present, non-null value
)

// resolution is the result of walking a path through an object.
type resolution struct {
	state fieldState
	value any // valid only when state == fieldValue
}

// resolve walks path through nested map[string]any values starting at
// root. A nil encountered at any step is an explicit null; a missing key
// (or a non-map intermediate) is Missing.
func resolve(root any, path []string) resolution {
	cur := root
	for _, key := range path {
		if cur == nil {
			return resolution{state: fieldNull}
		}
		m, ok := cur.(map[string]any)
		if !ok {
			return resolution{state: fieldMissing}
		}
		next, ok := m[key]
		if !ok {
			return resolution{state: fieldMissing}
		}
		cur = next
	}
	if cur == nil {
		return resolution{state: fieldNull}
	}
	return resolution{state: fieldValue, value: cur}
}

// toFloat coerces JSON-like numbers to float64.
func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int8:
		return float64(n), true
	case int16:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint8:
		return float64(n), true
	case uint16:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	}
	return 0, false
}

// valuesEqual compares two JSON-like values with numeric coercion.
func valuesEqual(a, b any) bool {
	if fa, ok := toFloat(a); ok {
		fb, ok := toFloat(b)
		return ok && fa == fb
	}
	return reflect.DeepEqual(a, b)
}

// compareOrdered returns -1, 0, +1 for ordered (numeric or string)
// values, and ok=false when the values are not mutually comparable.
func compareOrdered(a, b any) (int, bool) {
	if fa, ok := toFloat(a); ok {
		fb, ok := toFloat(b)
		if !ok {
			return 0, false
		}
		switch {
		case fa < fb:
			return -1, true
		case fa > fb:
			return 1, true
		}
		return 0, true
	}
	sa, okA := a.(string)
	sb, okB := b.(string)
	if okA && okB {
		return strings.Compare(sa, sb), true
	}
	return 0, false
}

// deepCopyValue returns a copy of a JSON-like value that shares no
// mutable state with the input, so compiled plans cannot be polluted by
// later mutation of the caller's rule data.
func deepCopyValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = deepCopyValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = deepCopyValue(val)
		}
		return out
	case []string:
		out := make([]string, len(t))
		copy(out, t)
		return out
	default:
		return v
	}
}

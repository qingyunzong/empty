package q204

import (
	"encoding/json"
	"fmt"
	"reflect"
)

// normalizeValue converts a structured event into the package's canonical
// JSON-like representation without retaining references into caller-owned
// maps or slices.
func normalizeValue(value any) (any, error) {
	switch v := value.(type) {
	case nil:
		return nil, nil
	case string:
		return v, nil
	case bool:
		return v, nil
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			normalized, err := normalizeValue(item)
			if err != nil {
				return nil, fmt.Errorf("%w at key %q: %v", ErrUnsupportedValue, key, err)
			}
			out[key] = normalized
		}
		return out, nil
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			normalized, err := normalizeValue(item)
			if err != nil {
				return nil, fmt.Errorf("%w at index %d: %v", ErrUnsupportedValue, i, err)
			}
			out[i] = normalized
		}
		return out, nil
	}

	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			return nil, fmt.Errorf("%w: map key type %s", ErrUnsupportedValue, rv.Type().Key())
		}
		if rv.IsNil() {
			return nil, nil
		}
		out := make(map[string]any, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			key := iter.Key().String()
			normalized, err := normalizeValue(iter.Value().Interface())
			if err != nil {
				return nil, fmt.Errorf("%w at key %q: %v", ErrUnsupportedValue, key, err)
			}
			out[key] = normalized
		}
		return out, nil
	case reflect.Slice, reflect.Array:
		if rv.Kind() == reflect.Slice && rv.IsNil() {
			return nil, nil
		}
		out := make([]any, rv.Len())
		for i := 0; i < rv.Len(); i++ {
			normalized, err := normalizeValue(rv.Index(i).Interface())
			if err != nil {
				return nil, fmt.Errorf("%w at index %d: %v", ErrUnsupportedValue, i, err)
			}
			out[i] = normalized
		}
		return out, nil
	case reflect.String:
		// json.Number is a string at the Go type level but represents a
		// numeric JSON value, so keep it distinct. Other named string types
		// are normalized to plain strings for HMAC handling.
		if rv.Type() == reflect.TypeOf(json.Number("")) {
			return value, nil
		}
		return rv.String(), nil
	case reflect.Bool:
		return value, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return value, nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return value, nil
	case reflect.Float32, reflect.Float64:
		return value, nil
	case reflect.Ptr, reflect.Interface:
		if rv.IsNil() {
			return nil, nil
		}
		return normalizeValue(rv.Elem().Interface())
	default:
		return nil, fmt.Errorf("%w: %T", ErrUnsupportedValue, value)
	}
}

func cloneValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		if v == nil {
			return map[string]any(nil)
		}
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = cloneValue(item)
		}
		return out
	case []any:
		if v == nil {
			return []any(nil)
		}
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = cloneValue(item)
		}
		return out
	default:
		return value
	}
}

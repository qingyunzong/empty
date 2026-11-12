package dataeng

import (
	"fmt"
	"reflect"
)

// validateValue restricts leaf values to scalar types that a flat record can
// carry. Nested structures are expressed exclusively through paths, so slices,
// maps and pointers are rejected as input rather than being silently nested.
func validateValue(value any) error {
	if value == nil {
		return nil
	}
	kind := reflect.TypeOf(value).Kind()
	switch kind {
	case reflect.Bool,
		reflect.String,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64:
		return nil
	default:
		return fmt.Errorf("unsupported leaf value type %T: only nil, bool, string, integers and floats are allowed", value)
	}
}

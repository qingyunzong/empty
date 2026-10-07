package matchcheck

import "strings"

// Value is a concrete value of a Type: an enum literal or a tuple.
type Value struct {
	Enum  string  // set for enum literals
	Tuple []Value // set for tuples
}

func (v Value) String() string {
	if v.Tuple == nil {
		return v.Enum
	}
	parts := make([]string, len(v.Tuple))
	for i, e := range v.Tuple {
		parts[i] = e.String()
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

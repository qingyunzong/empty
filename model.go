package dataeng

// Table is the ordered document model produced by Parse.
//
// Keys keep the order in which they were first introduced. A value is either
// a scalar (string, int64, float64, bool), []any (an array, whose elements may
// themselves be the same kinds of values), or *Table (a nested table).
//
// Arrays of tables are represented as []any whose elements are *Table.
type Table struct {
	keys   []string
	values map[string]any
}

// NewTable creates an empty Table.
func NewTable() *Table {
	return &Table{values: map[string]any{}}
}

// Keys returns the keys of the table in insertion order.
func (t *Table) Keys() []string {
	out := make([]string, len(t.keys))
	copy(out, t.keys)
	return out
}

// Has reports whether key exists in the table.
func (t *Table) Has(key string) bool {
	_, ok := t.values[key]
	return ok
}

// Get returns the value stored at key, or nil if the key is absent. Use Has to
// distinguish a missing key from a nil value.
func (t *Table) Get(key string) any {
	return t.values[key]
}

// Lookup walks a dotted key path and returns the terminal value. It returns
// (nil, false) when any intermediate component is missing or is not a *Table.
func (t *Table) Lookup(path ...string) (any, bool) {
	cur := t
	for i, part := range path {
		if i == len(path)-1 {
			v, ok := cur.values[part]
			return v, ok
		}
		next, ok := cur.values[part].(*Table)
		if !ok {
			return nil, false
		}
		cur = next
	}
	return nil, false
}

// Set stores value under key, inserting key in order when it is new.
func (t *Table) Set(key string, value any) {
	if _, ok := t.values[key]; !ok {
		t.keys = append(t.keys, key)
	}
	t.values[key] = value
}

// toMap converts the table into plain nested Go values, using map[string]any
// for tables and []any for arrays.
func (t *Table) toMap() map[string]any {
	out := make(map[string]any, len(t.keys))
	for _, k := range t.keys {
		out[k] = goValue(t.values[k])
	}
	return out
}

func goValue(v any) any {
	switch x := v.(type) {
	case *Table:
		return x.toMap()
	case []any:
		out := make([]any, len(x))
		for i, elem := range x {
			out[i] = goValue(elem)
		}
		return out
	default:
		return v
	}
}

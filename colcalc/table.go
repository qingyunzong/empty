package colcalc

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// Table is a JSON table: an ordered list of row objects. Rows may be
// heterogeneous; nothing is assumed from the first row.
type Table []Row

// ParseTable decodes a JSON array of objects into a Table. Numbers are
// decoded as json.Number to avoid precision surprises.
func ParseTable(data []byte) (Table, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var rows []map[string]any
	if err := dec.Decode(&rows); err != nil {
		return nil, fmt.Errorf("parse table: %w", err)
	}
	t := make(Table, len(rows))
	for i, r := range rows {
		if r == nil {
			r = map[string]any{}
		}
		t[i] = Row(r)
	}
	return t, nil
}

// Compute evaluates expr against every row independently and returns
// one Value per row, in row order.
func (t Table) Compute(expr Expr) []Value {
	p := Compile(expr)
	out := make([]Value, len(t))
	for i, row := range t {
		out[i] = p.Eval(row)
	}
	return out
}

// ComputeColumn evaluates expr per row and appends the results as a new
// column, returning the extended rows. Missing results leave the key
// absent; null, error and concrete results are stored under the key.
func (t Table) ComputeColumn(name string, expr Expr) []map[string]any {
	vals := t.Compute(expr)
	out := make([]map[string]any, len(t))
	for i, row := range t {
		nr := make(map[string]any, len(row)+1)
		for k, v := range row {
			nr[k] = v
		}
		switch v := vals[i]; v.Kind {
		case Missing:
			// leave absent
		case Null:
			nr[name] = nil
		case Error:
			nr[name] = map[string]string{"$error": v.Err.Error()}
		case Number:
			nr[name] = v.Num
		case String:
			nr[name] = v.Str
		case Bool:
			nr[name] = v.B
		}
		out[i] = nr
	}
	return out
}

// InferKinds reports the result kind of expr for each row individually.
// Types are inferred per row from that row's own data — never from the
// first row — so a column that is numeric in row 0 and textual in row 1
// reports [number, string], not [number, number].
func (t Table) InferKinds(expr Expr) []Kind {
	vals := t.Compute(expr)
	kinds := make([]Kind, len(vals))
	for i, v := range vals {
		kinds[i] = v.Kind
	}
	return kinds
}

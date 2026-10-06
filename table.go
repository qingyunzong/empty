package colcalc

import (
	"encoding/json"
	"fmt"
	"io"
)

// ParseTable decodes a JSON table (an array of objects) from r. Numbers
// are preserved as json.Number so no precision is lost before evaluation.
// A JSON null row decodes to an empty row.
func ParseTable(r io.Reader) ([]Row, error) {
	dec := json.NewDecoder(r)
	dec.UseNumber()
	var rows []Row
	if err := dec.Decode(&rows); err != nil {
		return nil, fmt.Errorf("colcalc: parsing JSON table: %w", err)
	}
	for i := range rows {
		if rows[i] == nil {
			rows[i] = Row{}
		}
	}
	return rows, nil
}

// Column binds a result column name to the expression that computes it.
type Column struct {
	Name string
	Expr Expr
}

// Compute evaluates each column expression against every row, one row at
// a time, and returns one result map per input row in the same order.
func Compute(rows []Row, cols ...Column) []map[string]Cell {
	out := make([]map[string]Cell, len(rows))
	for i, row := range rows {
		res := make(map[string]Cell, len(cols))
		for _, c := range cols {
			res[c.Name] = c.Expr.Eval(row)
		}
		out[i] = res
	}
	return out
}

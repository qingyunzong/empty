package dataeng

import (
	"errors"
	"sort"
)

// Tuple is a tuple supplied by the change stream. Values are positionally
// aligned with Columns. A nil Columns slice means all relation columns for New
// and Old tuples and the relation's identity columns for a Key tuple.
//
// New tuples must contain every relation column. Old tuples may contain a
// subset, which is useful for replica-identity key tuples. Key tuples must
// contain exactly the relation's identity columns, in any order.
type Tuple struct {
	Columns []int
	Values  []Value
}

// Row is a normalized, reassembled tuple. External values have been replaced
// by their chunk data. Columns lists relation column positions in ascending
// order and Values is aligned with it.
type Row struct {
	Columns []int
	Values  []Value
}

// Len returns the number of columns in the row.
func (r Row) Len() int { return len(r.Values) }

// ValueFor returns the value for a relation column position. A key-only row
// only contains identity columns.
func (r Row) ValueFor(column int) (Value, bool) {
	for i, col := range r.Columns {
		if col == column {
			return r.Values[i], true
		}
	}
	return Value{}, false
}

func (r Row) clone() Row {
	clone := Row{
		Columns: append([]int(nil), r.Columns...),
		Values:  make([]Value, len(r.Values)),
	}
	for i, value := range r.Values {
		clone.Values[i] = cloneValue(value)
	}
	return clone
}

type tupleRole uint8

const (
	newTuple tupleRole = iota
	oldTuple
	keyTuple
)

// ErrInvalidTuple reports a tuple that does not match its relation shape.
var ErrInvalidTuple = errors.New("dataeng: invalid tuple")

// ErrKeyNotIdentity reports a key tuple containing a non-identity column.
var ErrKeyNotIdentity = errors.New("dataeng: key contains a non-identity column")

// ErrMissingKey reports a key or identity column that is missing.
var ErrMissingKey = errors.New("dataeng: missing identity column")

// ErrNullKey reports a NULL value in an identity column.
var ErrNullKey = errors.New("dataeng: NULL identity value")

// ErrNoIdentity reports a key tuple on a relation without identity columns.
var ErrNoIdentity = errors.New("dataeng: relation has no identity columns")

func normalizeTuple(t *Tuple, rel Relation, role tupleRole) (*Row, error) {
	if t == nil {
		return nil, nil
	}

	indexes := append([]int(nil), t.Columns...)
	if t.Columns == nil {
		switch role {
		case keyTuple:
			indexes = rel.identityIndexes()
		default:
			indexes = make([]int, len(rel.Columns))
			for i := range indexes {
				indexes[i] = i
			}
		}
	}
	if len(indexes) != len(t.Values) {
		return nil, errorf(ErrInvalidTuple, "%d columns but %d values", len(indexes), len(t.Values))
	}

	present := make(map[int]struct{}, len(indexes))
	for _, index := range indexes {
		if index < 0 || index >= len(rel.Columns) {
			return nil, errorf(ErrInvalidTuple, "column index %d is out of range", index)
		}
		if _, ok := present[index]; ok {
			return nil, errorf(ErrInvalidTuple, "column index %d appears more than once", index)
		}
		present[index] = struct{}{}
	}

	switch role {
	case newTuple:
		if len(indexes) != len(rel.Columns) {
			return nil, errorf(ErrInvalidTuple, "new tuple must contain all %d columns", len(rel.Columns))
		}
	case keyTuple:
		identities := rel.identityIndexes()
		if len(identities) == 0 {
			return nil, ErrNoIdentity
		}
		for _, index := range indexes {
			if !rel.Columns[index].Identity {
				return nil, errorf(ErrKeyNotIdentity, "column %q", rel.Columns[index].Name)
			}
		}
		for _, index := range identities {
			if _, ok := present[index]; !ok {
				return nil, errorf(ErrMissingKey, "column %q", rel.Columns[index].Name)
			}
		}
	}

	type valuedColumn struct {
		index int
		value Value
	}
	ordered := make([]valuedColumn, len(indexes))
	for i, index := range indexes {
		ordered[i] = valuedColumn{index: index, value: cloneValue(t.Values[i])}
	}
	sort.Slice(ordered, func(i, j int) bool {
		return ordered[i].index < ordered[j].index
	})

	row := make([]Value, len(ordered))
	columns := make([]int, len(ordered))
	for i, item := range ordered {
		column := rel.Columns[item.index]
		if column.Identity && item.value.Kind == ValueNull {
			return nil, errorf(ErrNullKey, "column %q", column.Name)
		}
		if err := validateValue(item.value, column); err != nil {
			return nil, err
		}
		row[i] = item.value
		columns[i] = item.index
	}

	return &Row{Columns: columns, Values: row}, nil
}

// identityValues returns a key row from candidate rows. Candidates are tried in
// order; the first one containing every identity column wins.
func identityValues(rel Relation, candidates ...*Row) *Row {
	identities := rel.identityIndexes()
	if len(identities) == 0 {
		return nil
	}
	for _, candidate := range candidates {
		if candidate == nil {
			continue
		}
		values := make([]Value, 0, len(identities))
		for _, index := range identities {
			value, ok := candidate.ValueFor(index)
			if !ok {
				values = nil
				break
			}
			values = append(values, cloneValue(value))
		}
		if len(values) == len(identities) {
			return &Row{Columns: append([]int(nil), identities...), Values: values}
		}
	}
	return nil
}

func tupleReferences(rows ...*Row) map[ExternalID]struct{} {
	refs := make(map[ExternalID]struct{})
	for _, row := range rows {
		if row == nil {
			continue
		}
		for _, value := range row.Values {
			if value.Kind == ValueExternal {
				refs[value.Ref] = struct{}{}
			}
		}
	}
	return refs
}

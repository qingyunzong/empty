package dataeng

// Row is one row image keyed by column ID.
//
// A complete row contains every schema column with a concrete cell. Update
// after-images and before-images may be partial; omission (CellMissing) and
// CellUnchanged have the meanings documented by their cell kinds.
type Row map[string]Cell

// Clone returns a deep copy of the row.
func (r Row) Clone() Row {
	if r == nil {
		return nil
	}
	out := make(Row, len(r))
	for id, cell := range r {
		out[id] = cell.Clone()
	}
	return out
}

// Equal reports whether two rows have equal cells. An omitted key is
// equivalent to an explicit CellMissing value.
func (r Row) Equal(other Row) bool {
	for id, cell := range r {
		oc, ok := other[id]
		if !ok {
			oc = MissingCell()
		}
		if !cell.Equal(oc) {
			return false
		}
	}
	for id, cell := range other {
		if _, ok := r[id]; !ok && !cell.Equal(MissingCell()) {
			return false
		}
	}
	return true
}

func cloneRow(r Row) Row {
	return r.Clone()
}

func cloneSources(s map[string]FieldSource) map[string]FieldSource {
	if s == nil {
		return nil
	}
	out := make(map[string]FieldSource, len(s))
	for id, source := range s {
		out[id] = source
	}
	return out
}

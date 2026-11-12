package dataeng

// Expr is a compiled predicate. It is safe for concurrent use: the plan and
// schema it holds are immutable, and evaluation allocates fresh per-call
// working state.
type Expr struct {
	plan   boolPlan
	schema Schema
}

// Bitmap marks the rows that survive a filter. Only rows whose predicate
// evaluates to triTrue are selected; triFalse and triUnknown rows are absent.
type Bitmap struct {
	bits []uint64
	rows int
}

// Get reports whether row is selected. Rows outside the batch always report
// false.
func (m *Bitmap) Get(row int) bool {
	if row < 0 || row >= m.rows {
		return false
	}
	return m.bits[uint(row)>>6]&(uint64(1)<<(uint(row)&63)) != 0
}

// Rows returns the number of rows in the evaluated batch.
func (m *Bitmap) Rows() int { return m.rows }

// SelectedRows returns the indices of every selected row, in ascending
// order.
func (m *Bitmap) SelectedRows() []int {
	out := make([]int, 0)
	for row := 0; row < m.rows; row++ {
		if m.Get(row) {
			out = append(out, row)
		}
	}
	return out
}

// Evaluate validates the whole batch first and then runs the compiled
// predicate directly over the dictionary-encoded columns, returning a
// selection bitmap. Structural validation covers every schema column before
// any expression work, so evaluation short-circuits cannot bypass it.
func (e *Expr) Evaluate(b *Batch) (*Bitmap, error) {
	if err := validateBatch(e.schema, b); err != nil {
		return nil, err
	}
	result := e.plan.eval(b, b.RowCount)
	out := &Bitmap{bits: make([]uint64, len(result.trueBits)), rows: b.RowCount}
	for word := range out.bits {
		// Unknown rows never carry a true bit, so copying the true bitmap
		// keeps the filter restricted to triTrue rows.
		out.bits[word] = result.trueBits[word]
	}
	return out, nil
}

func (p cmpPlan) eval(b *Batch, rows int) *triVec {
	vec := newTriVec(rows)
	for row := 0; row < rows; row++ {
		vec.set(row, p.evalRow(b, row))
	}
	return vec
}

func (p cmpPlan) evalRow(b *Batch, row int) tri {
	left, leftNull := resolveAtom(p.left.atom(), b, row)
	right, rightNull := resolveAtom(p.right.atom(), b, row)
	if leftNull || rightNull {
		return triUnknown
	}
	if left.kind != right.kind {
		// Unreachable: Compile rejects mismatched operand types.
		return triUnknown
	}
	cmp := compareScalars(left, right)
	switch p.op {
	case CmpEq:
		return boolTri(cmp == 0)
	case CmpLt:
		return boolTri(cmp < 0)
	case CmpLe:
		return boolTri(cmp <= 0)
	default:
		return triUnknown
	}
}

func (p isNullPlan) eval(b *Batch, rows int) *triVec {
	vec := newTriVec(rows)
	at := p.value.atom()
	for row := 0; row < rows; row++ {
		_, isNull := resolveAtom(at, b, row)
		vec.set(row, boolTri(isNull))
	}
	return vec
}

func (p notPlan) eval(b *Batch, rows int) *triVec {
	inner := p.inner.eval(b, rows)
	vec := newTriVec(rows)
	for row := 0; row < rows; row++ {
		vec.set(row, not3(inner.get(row)))
	}
	return vec
}

func (p andPlan) eval(b *Batch, rows int) *triVec {
	left := p.left.eval(b, rows)
	right := p.right.eval(b, rows)
	vec := newTriVec(rows)
	for row := 0; row < rows; row++ {
		vec.set(row, and3(left.get(row), right.get(row)))
	}
	return vec
}

func (p orPlan) eval(b *Batch, rows int) *triVec {
	left := p.left.eval(b, rows)
	right := p.right.eval(b, rows)
	vec := newTriVec(rows)
	for row := 0; row < rows; row++ {
		vec.set(row, or3(left.get(row), right.get(row)))
	}
	return vec
}

func boolTri(value bool) tri {
	if value {
		return triTrue
	}
	return triFalse
}

// scalar is one resolved, non-null value. intVal is valid for TypeInt64 and
// strVal for TypeString.
type scalar struct {
	kind   ColumnType
	intVal int64
	strVal string
}

// resolveAtom reads one operand for a row directly from the dictionary,
// without materializing a decoded column.
func resolveAtom(at atom, b *Batch, row int) (scalar, bool) {
	if at.null {
		return scalar{}, true
	}
	if !at.isColumn {
		return scalar{kind: at.colType, intVal: at.intVal, strVal: at.strVal}, false
	}
	switch at.colType {
	case TypeInt64:
		col := b.Columns[at.name].(*Int64Column)
		idx := col.Values[row]
		if idx < 0 {
			return scalar{}, true
		}
		return scalar{kind: TypeInt64, intVal: col.Dict[idx]}, false
	case TypeString:
		col := b.Columns[at.name].(*StringColumn)
		idx := col.Values[row]
		if idx < 0 {
			return scalar{}, true
		}
		return scalar{kind: TypeString, strVal: col.Dict[idx]}, false
	}
	return scalar{}, true
}

func compareScalars(a, b scalar) int {
	switch a.kind {
	case TypeInt64:
		switch {
		case a.intVal < b.intVal:
			return -1
		case a.intVal > b.intVal:
			return 1
		default:
			return 0
		}
	case TypeString:
		switch {
		case a.strVal < b.strVal:
			return -1
		case a.strVal > b.strVal:
			return 1
		default:
			return 0
		}
	}
	return 0
}

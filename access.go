package dataeng

import "encoding/binary"

// Value is one value reached through a field path. Inline scalars occupy
// Range directly; reference-like values report their offset word in Range
// and the referenced object in RefRange. A missing scalar carries the schema
// default with Defaulted set; a missing reference is reported with IsNull.
type Value struct {
	Kind      Kind
	Present   bool
	IsNull    bool
	Defaulted bool
	Path      string
	Range     ByteRange
	RefRange  ByteRange

	scalar    int64
	str       string
	tablePos  uint64
	tableType *Table
	vector    *vectorInfo
	h         *Handle
}

// Root returns the validated root table value.
func (h *Handle) Root() *Value {
	info := h.tables[h.root]
	v := &Value{
		Kind:      KindTable,
		Present:   true,
		Path:      "",
		Range:     ByteRange{Start: h.root, End: h.root + uint64(info.vt.objectSize)},
		RefRange:  ByteRange{Start: h.root, End: h.root + uint64(info.vt.objectSize)},
		tablePos:  h.root,
		tableType: h.rootType,
	}
	v.h = h
	return v
}

// Get walks a field path from the root table.
func (h *Handle) Get(steps ...Step) (*Value, error) {
	v := h.Root()
	return v.Get(steps...)
}

// Get continues a path walk from this value. Table values accept Field steps;
// vector values accept Index steps.
func (v *Value) Get(steps ...Step) (*Value, error) {
	cur := v
	for _, step := range steps {
		next, err := cur.step(step)
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

func (v *Value) step(step Step) (*Value, error) {
	switch {
	case v.Kind == KindTable && step.Field != "":
		if v.IsNull {
			return nil, readError(v.Path, "cannot read field %q from null table", step.Field)
		}
		return readTableField(v, step.Field)
	case isVectorKind(v.Kind) && step.Field == "":
		return v.element(step.Index)
	default:
		return nil, readError(v.Path, "path step %+v does not match value kind %s", step, v.Kind)
	}
}

func handleForValue(v *Value) *Handle { return v.h }

func readTableField(parent *Value, name string) (*Value, error) {
	t := parent.tableType
	f := t.byName[name]
	if f == nil {
		return nil, readError(joinPath(parent.Path, name), "unknown field for table %q", t.name)
	}
	h := handleForValue(parent)
	path := joinPath(parent.Path, name)
	info := h.tables[parent.tablePos]
	off, present := info.vt.slotOffset(h.buf, f.Slot)
	if !present || off == 0 {
		mv := missingValue(f, path)
		mv.h = h
		return mv, nil
	}
	fieldPos := parent.tablePos + uint64(off)
	return h.readPresent(f, fieldPos, path)
}

func (h *Handle) readPresent(f *Field, fieldPos uint64, path string) (*Value, error) {
	if isScalarKind(f.Kind) {
		return h.readScalar(f, fieldPos, path), nil
	}
	rel := uint64(binary.LittleEndian.Uint32(h.buf[fieldPos : fieldPos+4]))
	target := uint64(uint32(fieldPos) + uint32(rel))
	fieldRange := ByteRange{Start: fieldPos, End: fieldPos + 4}
	switch f.Kind {
	case KindString:
		s := h.strings[target]
		sv := &Value{
			Kind:     KindString,
			Present:  true,
			Path:     path,
			Range:    fieldRange,
			RefRange: ByteRange{Start: target, End: s.start + s.size + 1},
			str:      string(h.buf[s.start : s.start+s.size]),
		}
		sv.h = h
		return sv, nil
	case KindTable:
		ti := h.tables[target]
		tv := &Value{
			Kind:      KindTable,
			Present:   true,
			Path:      path,
			Range:     fieldRange,
			RefRange:  ByteRange{Start: target, End: target + uint64(ti.vt.objectSize)},
			tablePos:  target,
			tableType: ti.typ,
		}
		tv.h = h
		return tv, nil
	default:
		vi := h.vectors[target]
		vv := &Value{
			Kind:     f.Kind,
			Present:  true,
			Path:     path,
			Range:    fieldRange,
			RefRange: ByteRange{Start: target, End: vi.elemStart + uint64(vi.count)*vi.elemSize},
			vector:   vi,
		}
		vv.h = h
		return vv, nil
	}
}

func (h *Handle) readScalar(f *Field, pos uint64, path string) *Value {
	v := &Value{Kind: f.Kind, Present: true, Path: path}
	switch f.Kind {
	case KindU8:
		v.scalar = int64(h.buf[pos])
		v.Range = ByteRange{Start: pos, End: pos + 1}
	case KindI32:
		v.scalar = int64(int32(binary.LittleEndian.Uint32(h.buf[pos : pos+4])))
		v.Range = ByteRange{Start: pos, End: pos + 4}
	case KindI64:
		v.scalar = int64(binary.LittleEndian.Uint64(h.buf[pos : pos+8]))
		v.Range = ByteRange{Start: pos, End: pos + 8}
	}
	v.RefRange = v.Range
	v.h = h
	return v
}

func missingValue(f *Field, path string) *Value {
	v := &Value{Kind: f.Kind, Path: path}
	if isScalarKind(f.Kind) {
		v.Defaulted = true
		v.scalar = f.Default
		return v
	}
	v.IsNull = true
	return v
}

// U8 returns the scalar value. ok is false for missing/non-u8 values.
func (v *Value) U8() (uint8, bool) {
	if v.Kind != KindU8 {
		return 0, false
	}
	return uint8(v.scalar), true
}

// I32 returns the scalar value. ok is false for missing/non-i32 values.
func (v *Value) I32() (int32, bool) {
	if v.Kind != KindI32 {
		return 0, false
	}
	return int32(v.scalar), true
}

// I64 returns the scalar value. ok is false for missing/non-i64 values.
func (v *Value) I64() (int64, bool) {
	if v.Kind != KindI64 {
		return 0, false
	}
	return v.scalar, true
}

// StringValue returns a copied string. ok is false for null/non-string values.
func (v *Value) StringValue() (string, bool) {
	if v.Kind != KindString || v.IsNull {
		return "", false
	}
	return v.str, true
}

// Table returns the object position and type of a table reference.
func (v *Value) Table() (position uint64, typ *Table, ok bool) {
	if v.Kind != KindTable || v.IsNull {
		return 0, nil, false
	}
	return v.tablePos, v.tableType, true
}

// VectorLen returns the element count of a vector value.
func (v *Value) VectorLen() (uint32, bool) {
	if !isVectorKind(v.Kind) || v.vector == nil {
		return 0, false
	}
	return v.vector.count, true
}

func (v *Value) element(index uint32) (*Value, error) {
	if v.vector == nil {
		return nil, readError(v.Path, "not a vector")
	}
	vi := v.vector
	if index >= vi.count {
		return nil, readError(v.Path, "vector index %d out of range [0,%d)", index, vi.count)
	}
	h := handleForValue(v)
	elemPos := vi.elemStart + uint64(index)*vi.elemSize
	path := indexPath(v.Path, index)
	if vi.elemKind != KindTable {
		return h.readScalar(&Field{Kind: vi.elemKind}, elemPos, path), nil
	}
	entryRange := ByteRange{Start: elemPos, End: elemPos + 4}
	rel := uint64(binary.LittleEndian.Uint32(h.buf[elemPos : elemPos+4]))
	target := uint64(uint32(elemPos) + uint32(rel))
	ti := h.tables[target]
	tv := &Value{
		Kind:      KindTable,
		Present:   true,
		Path:      path,
		Range:     entryRange,
		RefRange:  ByteRange{Start: target, End: target + uint64(ti.vt.objectSize)},
		tablePos:  target,
		tableType: ti.typ,
	}
	tv.h = h
	return tv, nil
}

// Element returns one vector element as a standalone Value.
func (v *Value) Element(index uint32) (*Value, error) {
	if !isVectorKind(v.Kind) {
		return nil, readError(v.Path, "value of kind %s has no vector elements", v.Kind)
	}
	return v.element(index)
}

// U8Elements returns a copy of every u8 vector element.
func (v *Value) U8Elements() ([]uint8, bool) {
	if v.Kind != KindVectorU8 || v.vector == nil {
		return nil, false
	}
	h := handleForValue(v)
	vi := v.vector
	out := make([]uint8, vi.count)
	copy(out, h.buf[vi.elemStart:vi.elemStart+uint64(vi.count)])
	return out, true
}

// I32Elements returns a copy of every i32 vector element.
func (v *Value) I32Elements() ([]int32, bool) {
	if v.Kind != KindVectorI32 || v.vector == nil {
		return nil, false
	}
	h := handleForValue(v)
	vi := v.vector
	out := make([]int32, vi.count)
	for i := range out {
		p := vi.elemStart + uint64(i)*4
		out[i] = int32(binary.LittleEndian.Uint32(h.buf[p : p+4]))
	}
	return out, true
}

// I64Elements returns a copy of every i64 vector element.
func (v *Value) I64Elements() ([]int64, bool) {
	if v.Kind != KindVectorI64 || v.vector == nil {
		return nil, false
	}
	h := handleForValue(v)
	vi := v.vector
	out := make([]int64, vi.count)
	for i := range out {
		p := vi.elemStart + uint64(i)*8
		out[i] = int64(binary.LittleEndian.Uint64(h.buf[p : p+8]))
	}
	return out, true
}

func indexPath(base string, index uint32) string {
	return base + "[" + itoa(index) + "]"
}

func itoa(n uint32) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

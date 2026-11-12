package dataeng

import (
	"encoding/binary"
	"fmt"
	"math"
	"unicode/utf8"
)

// Limits caps resource usage for one buffer. A value <= 0 means the
// corresponding resource is not limited. Every distinct object is charged
// once even if it is reached through several references.
type Limits struct {
	// MaxTables bounds the number of distinct table object positions.
	MaxTables int
	// MaxVectorElements bounds the sum of element counts of distinct vectors.
	MaxVectorElements int
	// MaxStringBytes bounds the sum of payload byte lengths of distinct strings.
	MaxStringBytes int
}

// ByteRange is the absolute half-open interval [Start, End) inside the
// borrowed buffer that a returned value occupies.
type ByteRange struct {
	Start uint64
	End   uint64
}

// Len returns the number of bytes in the range.
func (r ByteRange) Len() uint64 { return r.End - r.Start }

// Step is one field-path component given to Handle.Get or Value.Get.
// Field addresses a table field; Index addresses an element of a vector.
type Step struct {
	Field string
	Index uint32
}

type vtableInfo struct {
	objectSize uint16
	slotStart  uint64
	slotCount  int
}

func (vt *vtableInfo) slotOffset(buf []byte, slot uint16) (uint16, bool) {
	if int(slot) >= vt.slotCount {
		return 0, false
	}
	off := binary.LittleEndian.Uint16(buf[vt.slotStart+uint64(slot)*2:])
	return off, true
}

type tableInfo struct {
	typ *Table
	vt  *vtableInfo
}

type vectorInfo struct {
	elemKind  Kind
	count     uint32
	elemStart uint64
	elemSize  uint64
}

type stringInfo struct {
	start uint64
	size  uint64
}

// Handle is a validated read-only view of one borrowed buffer. The host must
// keep the underlying byte slice unchanged for the lifetime of the Handle.
type Handle struct {
	buf        []byte
	root       uint64
	rootType   *Table
	tables     map[uint64]*tableInfo
	vtables    map[uint64]*vtableInfo
	strings    map[uint64]stringInfo
	vectors    map[uint64]*vectorInfo
	vectorKind map[uint64]Kind
	limits     Limits
}

// Open validates every schema-known object reachable from the root table and
// returns a read handle only after the whole reachable graph passes.
func Open(root *Table, buf []byte, limits Limits) (*Handle, error) {
	if root == nil {
		return nil, openError("", "root table definition is nil")
	}
	if err := validateSchema(root); err != nil {
		return nil, err
	}
	if len(buf) < 4 {
		return nil, openError("", "buffer too short for root offset")
	}
	h := &Handle{
		buf:        buf,
		tables:     map[uint64]*tableInfo{},
		vtables:    map[uint64]*vtableInfo{},
		strings:    map[uint64]stringInfo{},
		vectors:    map[uint64]*vectorInfo{},
		vectorKind: map[uint64]Kind{},
		limits:     limits,
	}
	rootOff := uint64(binary.LittleEndian.Uint32(buf[:4]))
	if rootOff == 0 {
		return nil, openError("", "root offset must be positive")
	}
	rootPos, overflow := addOffset(4, rootOff)
	if overflow || !h.inRange(rootPos, 4) || rootPos%4 != 0 {
		return nil, openError("", "root table at %d out of range or not 4-aligned", rootPos)
	}
	h.root = rootPos
	h.rootType = root
	if err := h.validateTable(rootPos, root, ""); err != nil {
		return nil, err
	}
	return h, nil
}

func validateSchema(root *Table) error {
	seen := map[*Table]bool{}
	var walk func(t *Table, path string) error
	walk = func(t *Table, path string) error {
		if t == nil {
			return openError(path, "missing table definition")
		}
		if seen[t] {
			return nil
		}
		seen[t] = true
		for _, f := range t.fields {
			if !knownKind(f.Kind) {
				return openError(joinPath(path, f.Name), "unsupported kind %s", f.Kind)
			}
			if f.Kind == KindTable || f.Kind == KindVectorTable {
				if f.RefTable == nil {
					return openError(joinPath(path, f.Name), "field kind %s requires RefTable", f.Kind)
				}
				if err := walk(f.RefTable, joinPath(path, f.Name)); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return walk(root, "")
}

func addOffset(pos, rel uint64) (uint64, bool) {
	if rel > math.MaxUint64-pos {
		return 0, true
	}
	return pos + rel, false
}

func mulOverflow(a, b uint64) (uint64, bool) {
	if a == 0 || b == 0 {
		return 0, false
	}
	if a > math.MaxUint64/b {
		return 0, true
	}
	return a * b, false
}

func (h *Handle) inRange(pos, size uint64) bool {
	end, overflow := addOffset(pos, size)
	if overflow {
		return false
	}
	return end <= uint64(len(h.buf))
}

func (h *Handle) validateTable(pos uint64, t *Table, path string) error {
	if existing, ok := h.tables[pos]; ok {
		if existing.typ != t {
			return openError(path, "position %d already validated as table %q, cannot reuse as %q",
				pos, existing.typ.name, t.name)
		}
		return nil
	}
	if h.limits.MaxTables > 0 && len(h.tables) >= h.limits.MaxTables {
		return openError(path, "distinct table limit %d exceeded at position %d", h.limits.MaxTables, pos)
	}
	vt, err := h.loadVTable(pos, path)
	if err != nil {
		return err
	}
	// Reserve the position before descending so recursive tables terminate on
	// cycles instead of recursing forever.
	h.tables[pos] = &tableInfo{typ: t, vt: vt}
	for _, f := range t.fields {
		if err := h.validateField(pos, vt, f, path); err != nil {
			return err
		}
	}
	return nil
}

func (h *Handle) loadVTable(tablePos uint64, path string) (*vtableInfo, error) {
	if !h.inRange(tablePos, 4) {
		return nil, openError(path, "table at %d has no room for signed vtable distance", tablePos)
	}
	d := int64(int32(binary.LittleEndian.Uint32(h.buf[tablePos : tablePos+4])))
	vtPos := int64(tablePos) - d
	if vtPos < 0 {
		return nil, openError(path, "vtable position %d is before the buffer", vtPos)
	}
	vp := uint64(vtPos)
	if cached, ok := h.vtables[vp]; ok {
		return cached, nil
	}
	if !h.inRange(vp, 4) {
		return nil, openError(path, "vtable header at %d out of range", vp)
	}
	vtLen := uint64(binary.LittleEndian.Uint16(h.buf[vp : vp+2]))
	objectLen := uint64(binary.LittleEndian.Uint16(h.buf[vp+2 : vp+4]))
	if vtLen < 4 || vtLen%2 != 0 {
		return nil, openError(path, "vtable at %d has invalid byte length %d", vp, vtLen)
	}
	if objectLen < 4 {
		return nil, openError(path, "vtable at %d reports invalid object length %d", vp, objectLen)
	}
	if !h.inRange(vp, vtLen) {
		return nil, openError(path, "vtable range [%d,%d) exceeds buffer", vp, vp+vtLen)
	}
	if !h.inRange(tablePos, objectLen) {
		return nil, openError(path, "table object range [%d,%d) exceeds buffer", tablePos, tablePos+objectLen)
	}
	info := &vtableInfo{
		objectSize: uint16(objectLen),
		slotStart:  vp + 4,
		slotCount:  int(vtLen/2 - 2),
	}
	for i := 0; i < info.slotCount; i++ {
		off := uint64(binary.LittleEndian.Uint16(h.buf[info.slotStart+uint64(i)*2:]))
		if off != 0 && (off < 4 || off >= objectLen) {
			return nil, openError(path, "vtable slot %d at %d points outside [4,%d)", i, vp, objectLen)
		}
	}
	h.vtables[vp] = info
	return info, nil
}

func (h *Handle) validateField(tablePos uint64, vt *vtableInfo, f *Field, path string) error {
	fieldPath := joinPath(path, f.Name)
	off, present := vt.slotOffset(h.buf, f.Slot)
	if !present || off == 0 {
		return nil
	}
	fpos := tablePos + uint64(off)
	if isScalarKind(f.Kind) {
		width := uint64(scalarSize(f.Kind))
		if fpos < tablePos+4 {
			return openError(fieldPath, "field offset %d must be at least 4", off)
		}
		if fpos%width != 0 {
			return openError(fieldPath, "scalar at %d is not %d-aligned", fpos, width)
		}
		if !h.inRange(fpos, width) || fpos+width > tablePos+uint64(vt.objectSize) {
			return openError(fieldPath, "value width %d exceeds object length %d", width, vt.objectSize)
		}
		return nil
	}
	if fpos%4 != 0 {
		return openError(fieldPath, "reference field at %d is not 4-aligned", fpos)
	}
	if !h.inRange(fpos, 4) || fpos+4 > tablePos+uint64(vt.objectSize) {
		return openError(fieldPath, "reference width 4 exceeds object length %d", vt.objectSize)
	}
	return h.validateReference(fpos, f, fieldPath)
}

func (h *Handle) validateReference(fieldPos uint64, f *Field, path string) error {
	rel := uint64(binary.LittleEndian.Uint32(h.buf[fieldPos : fieldPos+4]))
	if rel == 0 {
		return openError(path, "stored reference offset is zero; null references must omit the field")
	}
	// Offsets are uint32 words: a target behind the reference position wraps
	// in 32-bit arithmetic and remains legal. Only an out-of-bounds resulting
	// position is corruption.
	target := uint64(uint32(fieldPos) + uint32(rel))
	if !h.inRange(target, 1) {
		return openError(path, "reference target %d wraps or leaves the buffer", target)
	}
	if target%4 != 0 {
		return openError(path, "reference target %d is not 4-aligned", target)
	}
	switch f.Kind {
	case KindString:
		return h.validateString(target, path)
	case KindTable:
		return h.validateTable(target, f.RefTable, path)
	case KindVectorU8, KindVectorI32, KindVectorI64, KindVectorTable:
		return h.validateVector(target, f, path)
	default:
		return openError(path, "field kind %s cannot hold a reference", f.Kind)
	}
}

func (h *Handle) validateString(pos uint64, path string) error {
	if _, ok := h.strings[pos]; ok {
		return nil
	}
	if !h.inRange(pos, 4) {
		return openError(path, "string length word at %d out of range", pos)
	}
	length := uint64(binary.LittleEndian.Uint32(h.buf[pos : pos+4]))
	if !h.inRange(pos+4, length) || !h.inRange(pos+4+length, 1) {
		return openError(path, "string at %d with %d payload bytes exceeds buffer", pos, length)
	}
	if h.buf[pos+4+length] != 0 {
		return openError(path, "string at %d missing NUL terminator", pos)
	}
	payload := h.buf[pos+4 : pos+4+length]
	if !utf8.Valid(payload) {
		return openError(path, "string at %d is not valid UTF-8", pos)
	}
	if h.limits.MaxStringBytes > 0 && h.usedStringBytes()+length > uint64(h.limits.MaxStringBytes) {
		return openError(path, "distinct string byte limit %d exceeded", h.limits.MaxStringBytes)
	}
	h.strings[pos] = stringInfo{start: pos + 4, size: length}
	return nil
}

func (h *Handle) usedStringBytes() uint64 {
	var total uint64
	for _, s := range h.strings {
		total += s.size
	}
	return total
}

func (h *Handle) validateVector(pos uint64, f *Field, path string) error {
	if _, ok := h.vectors[pos]; ok {
		if h.vectorKind[pos] != f.Kind {
			return openError(path, "position %d already validated as vector kind %s, cannot reuse as %s",
				pos, h.vectorKind[pos], f.Kind)
		}
		return nil
	}
	if !h.inRange(pos, 4) {
		return openError(path, "vector length word at %d out of range", pos)
	}
	count := uint64(binary.LittleEndian.Uint32(h.buf[pos : pos+4]))
	elemKind := vectorElementKind(f.Kind)
	elemSize := uint64(4)
	if elemKind == KindU8 {
		elemSize = 1
	} else if elemKind == KindI64 {
		elemSize = 8
	}
	elemStart := pos + 4
	if elemKind == KindI64 && elemStart%8 != 0 {
		return openError(path, "i64 vector element area at %d is not 8-aligned", elemStart)
	}
	dataBytes, overflow := mulOverflow(count, elemSize)
	if overflow || !h.inRange(elemStart, dataBytes) {
		return openError(path, "vector at %d with %d elements exceeds buffer", pos, count)
	}
	if h.limits.MaxVectorElements > 0 && h.usedVectorElements()+count > uint64(h.limits.MaxVectorElements) {
		return openError(path, "distinct vector element limit %d exceeded", h.limits.MaxVectorElements)
	}
	info := &vectorInfo{
		elemKind:  elemKind,
		count:     uint32(count),
		elemStart: elemStart,
		elemSize:  elemSize,
	}
	h.vectors[pos] = info
	h.vectorKind[pos] = f.Kind
	if elemKind == KindTable {
		for i := uint64(0); i < count; i++ {
			entryPos := elemStart + i*4
			entryPath := fmt.Sprintf("%s[%d]", path, i)
			if err := h.validateReference(entryPos, &Field{
				Name:     f.Name,
				Kind:     KindTable,
				RefTable: f.RefTable,
			}, entryPath); err != nil {
				return err
			}
		}
	}
	return nil
}

func (h *Handle) usedVectorElements() uint64 {
	var total uint64
	for _, v := range h.vectors {
		total += uint64(v.count)
	}
	return total
}

func joinPath(base, field string) string {
	if base == "" {
		return field
	}
	return base + "." + field
}

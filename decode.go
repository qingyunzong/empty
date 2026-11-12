package dataeng

import (
	"encoding/binary"
	"fmt"
	"math"
	"sort"
)

// Default host budgets.
const (
	DefaultMaxDepth    = 32
	DefaultMaxElements = 1 << 20
	DefaultMaxBytes    = 8 << 20
)

// Limits bounds the resources used by one decoder. A zero field selects the
// corresponding default. A negative field disables that particular limit.
type Limits struct {
	MaxDepth    int
	MaxElements int
	MaxBytes    int
}

// Budget is an alias for Limits.
type Budget = Limits

// DefaultLimits returns the package's default host budget.
func DefaultLimits() Limits {
	return Limits{
		MaxDepth:    DefaultMaxDepth,
		MaxElements: DefaultMaxElements,
		MaxBytes:    DefaultMaxBytes,
	}
}

func (l Limits) normalized() Limits {
	if l.MaxDepth == 0 {
		l.MaxDepth = DefaultMaxDepth
	}
	if l.MaxElements == 0 {
		l.MaxElements = DefaultMaxElements
	}
	if l.MaxBytes == 0 {
		l.MaxBytes = DefaultMaxBytes
	}
	return l
}

// Decoder incrementally decodes exactly one value. Input may be supplied in
// arbitrarily split chunks, including splits in the middle of a varint or a
// value. A failure is sticky and no partial value is ever returned.
type Decoder struct {
	schema *Schema
	limits Limits

	buf      []byte
	value    *Value
	complete bool
	consumed int
	err      error
}

// NewDecoder returns a decoder for schema. If no limits are supplied the
// defaults are used; at most one Limits value is accepted.
func NewDecoder(schema *Schema, limits ...Limits) *Decoder {
	d := &Decoder{schema: schema, limits: DefaultLimits()}
	if len(limits) > 1 {
		d.err = fmt.Errorf("%w: at most one Limits value may be supplied", ErrSchema)
		return d
	}
	if len(limits) == 1 {
		d.limits = limits[0].normalized()
	}
	if err := validateSchema(schema); err != nil {
		d.err = err
	}
	return d
}

// Feed supplies another input chunk. It returns nil while more bytes are
// needed, and returns an error as soon as the payload is malformed, the value
// is complete and followed by more input, or a budget is exceeded.
func (d *Decoder) Feed(chunk []byte) error {
	if d.err != nil {
		return d.err
	}
	if d.complete {
		if len(chunk) > 0 {
			return d.fail(fmt.Errorf("%w: %d byte(s) after the value", ErrTrailingBytes, len(chunk)))
		}
		return nil
	}
	if len(chunk) > 0 {
		d.buf = append(d.buf, chunk...)
	}
	return d.tryDecode()
}

// Write implements io.Writer by forwarding to Feed.
func (d *Decoder) Write(chunk []byte) (int, error) {
	if err := d.Feed(chunk); err != nil {
		return 0, err
	}
	return len(chunk), nil
}

// Finish marks the end of input. It returns the complete value, or an error
// if the value is incomplete. Once the decoder has failed it remains failed.
func (d *Decoder) Finish() (*Value, error) {
	if d.err != nil {
		return nil, d.err
	}
	if !d.complete {
		if err := d.tryDecode(); err != nil {
			return nil, err
		}
		if !d.complete {
			return nil, d.fail(fmt.Errorf("%w: %d byte(s) buffered", ErrIncomplete, len(d.buf)))
		}
	}
	return d.value, nil
}

// Decode feeds the optional chunks and then calls Finish.
func (d *Decoder) Decode(chunks ...[]byte) (*Value, error) {
	for _, chunk := range chunks {
		if err := d.Feed(chunk); err != nil {
			return nil, err
		}
	}
	return d.Finish()
}

// Err returns the sticky decoder error, if any.
func (d *Decoder) Err() error {
	return d.err
}

// Complete reports whether a value has been decoded successfully.
func (d *Decoder) Complete() bool {
	return d.complete
}

// Value returns the decoded value, or nil before successful completion.
func (d *Decoder) Value() *Value {
	if !d.complete {
		return nil
	}
	return d.value
}

func (d *Decoder) tryDecode() error {
	if d.err != nil {
		return d.err
	}
	if d.complete {
		return nil
	}

	p := &parser{
		buf:        d.buf,
		schema:     d.schema,
		limits:     d.limits,
		fieldCache: make(map[*Schema][]resolvedField),
	}
	value, consumed, err := p.parseRoot()
	if err == errNeedMore {
		return nil
	}
	if err != nil {
		return d.fail(err)
	}
	if consumed != len(d.buf) {
		return d.fail(fmt.Errorf("%w: %d byte(s) after the value", ErrTrailingBytes, len(d.buf)-consumed))
	}
	d.value = value
	d.consumed = consumed
	d.complete = true
	return nil
}

func (d *Decoder) fail(err error) error {
	if d.err == nil {
		d.err = err
		d.value = nil
		d.complete = false
	}
	return d.err
}

// Decode decodes exactly one value from data. It fails if data ends before the
// value is complete or if bytes remain after the value.
func Decode(data []byte, schema *Schema, limits ...Limits) (*Value, error) {
	d := NewDecoder(schema, limits...)
	if err := d.Feed(data); err != nil {
		return nil, err
	}
	return d.Finish()
}

// DecodeValue is an alias for Decode.
func DecodeValue(data []byte, schema *Schema, limits ...Limits) (*Value, error) {
	return Decode(data, schema, limits...)
}

type resolvedField struct {
	id     uint32
	typ    Type
	schema *Schema
}

type parser struct {
	buf    []byte
	pos    int
	schema *Schema
	limits Limits
	depth  int

	fieldCache map[*Schema][]resolvedField
}

func (p *parser) parseRoot() (*Value, int, error) {
	if p.schema == nil {
		return nil, p.pos, fmt.Errorf("%w: nil root schema", ErrSchema)
	}
	value, err := p.parseValue(p.schema)
	if err != nil {
		return nil, p.pos, err
	}
	return value, p.pos, nil
}

func (p *parser) parseValue(s *Schema) (*Value, error) {
	if s == nil {
		return nil, fmt.Errorf("%w: nil value schema", ErrSchema)
	}

	switch s.Type {
	case TypeTrue:
		return &Value{Type: TypeTrue, Bool: true}, nil
	case TypeFalse:
		return &Value{Type: TypeFalse, Bool: false}, nil
	case TypeByte:
		if p.pos >= len(p.buf) {
			return nil, errNeedMore
		}
		b := p.buf[p.pos]
		p.pos++
		return &Value{Type: TypeByte, Byte: b, Int: int64(b)}, nil
	case TypeInt16:
		n, err := p.readZigZag(16)
		if err != nil {
			return nil, err
		}
		return &Value{Type: TypeInt16, Int: n}, nil
	case TypeInt32:
		n, err := p.readZigZag(32)
		if err != nil {
			return nil, err
		}
		return &Value{Type: TypeInt32, Int: n}, nil
	case TypeInt64:
		n, err := p.readZigZag(64)
		if err != nil {
			return nil, err
		}
		return &Value{Type: TypeInt64, Int: n}, nil
	case TypeFloat64:
		if len(p.buf)-p.pos < 8 {
			return nil, errNeedMore
		}
		bits := binary.LittleEndian.Uint64(p.buf[p.pos : p.pos+8])
		p.pos += 8
		return &Value{
			Type:      TypeFloat64,
			Float:     math.Float64frombits(bits),
			FloatBits: bits,
		}, nil
	case TypeBytes:
		return p.parseBytes()
	case TypeList:
		return p.parseList(s, TypeList)
	case TypeSet:
		return p.parseList(s, TypeSet)
	case TypeMap:
		return p.parseMap(s)
	case TypeStruct:
		return p.parseStruct(s)
	default:
		return nil, fmt.Errorf("%w: unknown value type %d", ErrCorrupt, s.Type)
	}
}

func (p *parser) readZigZag(bits int) (int64, error) {
	u, next, err := readULEB(p.buf, p.pos, bits)
	if err != nil {
		return 0, err
	}
	v, err := zigzagDecode(u, bits)
	if err != nil {
		return 0, err
	}
	p.pos = next
	return v, nil
}

func (p *parser) readNonNegative32() (int64, error) {
	v, err := p.readZigZag(32)
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, fmt.Errorf("%w: %d", ErrNegativeQuantity, v)
	}
	return v, nil
}

func (p *parser) parseBytes() (*Value, error) {
	length, err := p.readNonNegative32()
	if err != nil {
		return nil, err
	}
	if p.limits.MaxBytes >= 0 && length > int64(p.limits.MaxBytes) {
		return nil, fmt.Errorf("%w: byte length %d exceeds %d", ErrBudget, length, p.limits.MaxBytes)
	}
	if length > int64(len(p.buf)-p.pos) {
		return nil, errNeedMore
	}
	data := make([]byte, int(length))
	copy(data, p.buf[p.pos:p.pos+int(length)])
	p.pos += int(length)
	return &Value{Type: TypeBytes, Bytes: data}, nil
}

func (p *parser) parseList(s *Schema, kind Type) (*Value, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer p.leave()

	if s.Type != kind {
		return nil, fmt.Errorf("%w: container schema type %d does not match %d", ErrSchema, s.Type, kind)
	}
	if s.Elem == nil {
		return nil, fmt.Errorf("%w: container has no element schema", ErrSchema)
	}

	if p.pos >= len(p.buf) {
		return nil, errNeedMore
	}
	header := p.buf[p.pos]
	p.pos++

	high := header >> 4
	elemType := Type(header & 0x0f)
	count := int64(high)
	if high == 15 {
		var err error
		count, err = p.readNonNegative32()
		if err != nil {
			return nil, err
		}
	}

	if !elemType.validContainerComponent() {
		return nil, fmt.Errorf("%w: container element type %d is not permitted", ErrCorrupt, elemType)
	}
	if p.limits.MaxElements >= 0 && count > int64(p.limits.MaxElements) {
		return nil, fmt.Errorf("%w: element count %d exceeds %d", ErrBudget, count, p.limits.MaxElements)
	}
	if s.Elem.Type != elemType {
		return nil, fmt.Errorf("%w: element type %d, schema expects %d", ErrSchemaMismatch, elemType, s.Elem.Type)
	}

	elements := make([]Value, 0, capacityHint(count))
	for i := int64(0); i < count; i++ {
		element, err := p.parseValue(s.Elem)
		if err != nil {
			return nil, err
		}
		elements = append(elements, *element)
	}
	return &Value{Type: kind, Elements: elements}, nil
}

func (p *parser) parseMap(s *Schema) (*Value, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer p.leave()

	if s.Type != TypeMap {
		return nil, fmt.Errorf("%w: map schema has type %d", ErrSchema, s.Type)
	}
	if s.Key == nil || s.Value == nil {
		return nil, fmt.Errorf("%w: map needs key and value schemas", ErrSchema)
	}

	count, err := p.readNonNegative32()
	if err != nil {
		return nil, err
	}
	if p.limits.MaxElements >= 0 && count > int64(p.limits.MaxElements) {
		return nil, fmt.Errorf("%w: pair count %d exceeds %d", ErrBudget, count, p.limits.MaxElements)
	}
	entries := make([]MapEntry, 0, capacityHint(count))

	if count == 0 {
		return &Value{Type: TypeMap, Entries: entries}, nil
	}

	if p.pos >= len(p.buf) {
		return nil, errNeedMore
	}
	header := p.buf[p.pos]
	p.pos++
	keyType := Type(header >> 4)
	valueType := Type(header & 0x0f)
	if !keyType.validContainerComponent() {
		return nil, fmt.Errorf("%w: map key type %d is not permitted", ErrCorrupt, keyType)
	}
	if !valueType.validContainerComponent() {
		return nil, fmt.Errorf("%w: map value type %d is not permitted", ErrCorrupt, valueType)
	}
	if s.Key.Type != keyType {
		return nil, fmt.Errorf("%w: map key type %d, schema expects %d", ErrSchemaMismatch, keyType, s.Key.Type)
	}
	if s.Value.Type != valueType {
		return nil, fmt.Errorf("%w: map value type %d, schema expects %d", ErrSchemaMismatch, valueType, s.Value.Type)
	}

	for i := int64(0); i < count; i++ {
		key, err := p.parseValue(s.Key)
		if err != nil {
			return nil, err
		}
		value, err := p.parseValue(s.Value)
		if err != nil {
			return nil, err
		}
		entries = append(entries, MapEntry{Key: *key, Value: *value})
	}
	return &Value{Type: TypeMap, Entries: entries}, nil
}

func (p *parser) parseStruct(s *Schema) (*Value, error) {
	if err := p.enter(); err != nil {
		return nil, err
	}
	defer p.leave()

	if s.Type != TypeStruct {
		return nil, fmt.Errorf("%w: structure schema has type %d", ErrSchema, s.Type)
	}
	expected, err := p.resolvedFields(s)
	if err != nil {
		return nil, err
	}

	fields := make([]FieldValue, 0, capacityHint(int64(len(expected))))
	lastID := uint32(0)
	next := 0

	for {
		if p.pos >= len(p.buf) {
			return nil, errNeedMore
		}
		header := p.buf[p.pos]
		p.pos++
		high := header >> 4
		fieldType := Type(header & 0x0f)

		if fieldType == TypeEnd {
			if high != 0 {
				return nil, fmt.Errorf("%w: structure end marker has nonzero high nibble", ErrCorrupt)
			}
			if next != len(expected) {
				return nil, fmt.Errorf("%w: missing structure field %d", ErrSchemaMismatch, expected[next].id)
			}
			return &Value{Type: TypeStruct, Fields: fields}, nil
		}
		if !fieldType.validValue() {
			return nil, fmt.Errorf("%w: unknown field type %d", ErrCorrupt, fieldType)
		}

		var id uint32
		if high != 0 {
			sum := uint64(lastID) + uint64(high)
			if sum > math.MaxUint32 {
				return nil, fmt.Errorf("%w: field identifier overflow", ErrFieldID)
			}
			id = uint32(sum)
		} else {
			n, err := p.readZigZag(32)
			if err != nil {
				return nil, err
			}
			if n <= 0 {
				return nil, fmt.Errorf("%w: field identifier %d must be positive", ErrFieldID, n)
			}
			id = uint32(n)
		}
		if id <= lastID {
			return nil, fmt.Errorf("%w: field identifier %d does not exceed %d", ErrFieldID, id, lastID)
		}

		if next >= len(expected) {
			return nil, fmt.Errorf("%w: unexpected structure field %d", ErrSchemaMismatch, id)
		}
		field := expected[next]
		if id < field.id {
			return nil, fmt.Errorf("%w: unexpected structure field %d", ErrSchemaMismatch, id)
		}
		if id > field.id {
			return nil, fmt.Errorf("%w: missing structure field %d", ErrSchemaMismatch, field.id)
		}
		if fieldType != field.typ {
			return nil, fmt.Errorf("%w: field %d has type %d, schema expects %d", ErrSchemaMismatch, id, fieldType, field.typ)
		}

		value, err := p.parseValue(field.schema)
		if err != nil {
			return nil, err
		}
		fields = append(fields, FieldValue{ID: id, Value: *value})
		lastID = id
		next++
	}
}

func (p *parser) enter() error {
	p.depth++
	if p.limits.MaxDepth >= 0 && p.depth > p.limits.MaxDepth {
		depth := p.depth
		p.depth--
		return fmt.Errorf("%w: nesting depth %d exceeds %d", ErrBudget, depth, p.limits.MaxDepth)
	}
	return nil
}

func (p *parser) leave() {
	p.depth--
}

func capacityHint(count int64) int {
	if count > 16 {
		return 16
	}
	if count < 0 {
		return 0
	}
	return int(count)
}

func (p *parser) resolvedFields(s *Schema) ([]resolvedField, error) {
	if fields, ok := p.fieldCache[s]; ok {
		return fields, nil
	}
	sorted := append([]FieldSchema(nil), s.Fields...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].ID < sorted[j].ID
	})
	fields := make([]resolvedField, len(sorted))
	for i, f := range sorted {
		child, err := resolveField(f)
		if err != nil {
			return nil, err
		}
		fields[i] = resolvedField{id: f.ID, typ: child.Type, schema: child}
	}
	p.fieldCache[s] = fields
	return fields, nil
}

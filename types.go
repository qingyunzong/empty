package dataeng

// FieldKind identifies the kind of value stored in a field.
type FieldKind uint8

const (
	// Numeric is an IEEE 754 binary64 field. Every numeric field occupies
	// exactly one compressed slot.
	Numeric FieldKind = iota
	// Bytes is a raw byte-string field. A field of width w occupies
	// ceil(w/8) compressed slots.
	Bytes
)

func (k FieldKind) String() string {
	switch k {
	case Numeric:
		return "numeric"
	case Bytes:
		return "bytes"
	default:
		return "unknown"
	}
}

// ByteOrder selects the byte order used by literal numeric slots in the
// compressed region. Integer opcodes are not affected by this setting.
type ByteOrder uint8

const (
	LittleEndian ByteOrder = iota
	BigEndian
)

// Field declares one field in host order.
//
// For Numeric fields Width is ignored. For Bytes fields Width is the number
// of output bytes and must be in the range 1..1048576.
type Field struct {
	Name  string
	Kind  FieldKind
	Width int
}

// NumericField returns a numeric field declaration.
func NumericField(name string) Field {
	return Field{Name: name, Kind: Numeric}
}

// BytesField returns a bytes field declaration of the given width.
func BytesField(name string, width int) Field {
	return Field{Name: name, Kind: Bytes, Width: width}
}

// Config describes the closed S8 data region to decode.
//
// Projection is an optional subset of field names. If it is empty the decoder
// emits every field in declaration order. A non-empty projection emits only
// the listed fields and preserves the requested order. Fields not in the
// projection are still fully validated.
type Config struct {
	Fields        []Field
	NumericEndian ByteOrder
	Bias          int
	MaxRows       uint64
	RowByteBudget int
	Projection    []string
}

// NoLiteralOffset is the LiteralOffset value used when a slot did not consume
// a physical literal slot.
const NoLiteralOffset int64 = -1

// SystemMissingBits is the fixed binary64 pattern that opcode 253 converts to
// missing. Opcode 255 produces the same pattern.
const SystemMissingBits uint64 = 0xffefffffffffffff

// Source identifies the physical origin of one output slot.
//
// GroupOffset is the absolute byte offset of the eight-byte opcode header in
// which the code appeared. CodeIndex is the zero-based position within that
// header. LiteralOffset and LiteralLength describe the physical literal slot
// consumed by opcode 253. For all other opcodes LiteralOffset is
// NoLiteralOffset and LiteralLength is zero.
type Source struct {
	GroupOffset   int64
	CodeIndex     int
	LiteralOffset int64
	LiteralLength int
}

// Fragment is one contiguous contribution to a bytes value. Each compressed
// slot that contributed to the field becomes one fragment.
type Fragment struct {
	Data   []byte
	Source Source
}

// Value is one projected output field.
//
// Numeric values use Missing and Bits. Bits is the canonical IEEE 754 binary64
// bit pattern (not a byte-swapped literal). Missing values carry the system
// missing pattern 0xffefffffffffffff. Bytes values use Data, which is the
// concatenated and width-trimmed value, and Fragments, which carry per-slot
// physical provenance. For bytes, Source is the first fragment's source.
type Value struct {
	Field     string
	Kind      FieldKind
	Missing   bool
	Bits      uint64
	Data      []byte
	Source    Source
	Fragments []Fragment
}

// Row is one completed decoded row. Values are in projection order.
type Row struct {
	Values []Value
}

// Get returns the value for name, if that field is present in the row.
func (r Row) Get(name string) (Value, bool) {
	for _, v := range r.Values {
		if v.Field == name {
			return v, true
		}
	}
	return Value{}, false
}

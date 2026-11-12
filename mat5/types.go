package mat5

// Endian selects the fixed byte order used throughout one input stream.
type Endian int

const (
	LittleEndian Endian = iota
	BigEndian
)

// Limits are host-supplied budgets enforced while parsing. Every field must be
// greater than zero. Checks happen during the parse, before allocating storage
// sized by untrusted length fields.
type Limits struct {
	// MaxInflatedBytes bounds the cumulative number of bytes produced by zlib.
	MaxInflatedBytes uint64
	// MaxMatrixNodes bounds the number of matrix elements, including cell children.
	MaxMatrixNodes uint64
	// MaxNumericCells bounds the total number of double/int32 numeric elements.
	MaxNumericCells uint64
	// MaxDepth bounds matrix nesting depth; a top-level matrix has depth 1.
	MaxDepth int
}

// Range is a half-open byte interval [Start, End).
type Range struct {
	Start uint64
	End   uint64
}

// Source records where an element's bytes came from.
//
// Physical always covers the element header and payload inside the original
// input stream (padding excluded). For material reconstructed from a zlib
// payload, Inflated is true and Logical gives the range inside the inflated
// byte stream; the logical offset is never reported as a direct file offset.
type Source struct {
	Physical Range
	Inflated bool
	Logical  Range
}

// ValueClass enumerates the supported array classes.
type ValueClass int

const (
	ClassCell   ValueClass = 1
	ClassDouble ValueClass = 6
	ClassInt32  ValueClass = 12
)

// String implements fmt.Stringer.
func (c ValueClass) String() string {
	switch c {
	case ClassCell:
		return "cell"
	case ClassDouble:
		return "double"
	case ClassInt32:
		return "int32"
	default:
		return "unknown"
	}
}

// Value is one parsed matrix. The backing slices are owned by the parser and
// must be treated as read-only.
type Value interface {
	Class() ValueClass
	Dims() []int32
	Source() Source
	NumElements() uint64
}

// DoubleMatrix holds a real or complex double array. Bit patterns, including
// NaN payloads and negative zero, are preserved without floating-point work.
type DoubleMatrix struct {
	name string
	dims []int32
	real []uint64
	imag []uint64 // nil for real-only arrays
	src  Source
}

// Class returns ClassDouble.
func (m *DoubleMatrix) Class() ValueClass { return ClassDouble }

// Dims returns a copy of the dimension vector.
func (m *DoubleMatrix) Dims() []int32 {
	out := make([]int32, len(m.dims))
	copy(out, m.dims)
	return out
}

// Source returns the provenance of the matrix element.
func (m *DoubleMatrix) Source() Source { return m.src }

// NumElements returns the column-major element count.
func (m *DoubleMatrix) NumElements() uint64 { return uint64(len(m.real)) }

// Complex reports whether the array carries an imaginary part.
func (m *DoubleMatrix) Complex() bool { return m.imag != nil }

// RealBits returns the raw 64-bit patterns of the real part in column-major
// order. The returned slice must not be modified.
func (m *DoubleMatrix) RealBits() []uint64 { return m.real }

// ImagBits returns the raw 64-bit patterns of the imaginary part, or nil for a
// real-only array. The returned slice must not be modified.
func (m *DoubleMatrix) ImagBits() []uint64 { return m.imag }

// At resolves a full multidimensional coordinate (column-major) and returns the
// raw real and imaginary bit patterns. imag is zero when the array is real.
func (m *DoubleMatrix) At(coord ...int32) (real, imag uint64, err error) {
	off, err := colMajorOffset(m.dims, coord)
	if err != nil {
		return 0, 0, err
	}
	if m.imag != nil {
		return m.real[off], m.imag[off], nil
	}
	return m.real[off], 0, nil
}

// Int32Matrix holds an int32 numeric array.
type Int32Matrix struct {
	name   string
	dims   []int32
	values []int32
	src    Source
}

// Class returns ClassInt32.
func (m *Int32Matrix) Class() ValueClass { return ClassInt32 }

// Dims returns a copy of the dimension vector.
func (m *Int32Matrix) Dims() []int32 {
	out := make([]int32, len(m.dims))
	copy(out, m.dims)
	return out
}

// Source returns the provenance of the matrix element.
func (m *Int32Matrix) Source() Source { return m.src }

// NumElements returns the column-major element count.
func (m *Int32Matrix) NumElements() uint64 { return uint64(len(m.values)) }

// Values returns the int32 data in column-major order. The returned slice must
// not be modified.
func (m *Int32Matrix) Values() []int32 { return m.values }

// At resolves a full multidimensional coordinate (column-major).
func (m *Int32Matrix) At(coord ...int32) (int32, error) {
	off, err := colMajorOffset(m.dims, coord)
	if err != nil {
		return 0, err
	}
	return m.values[off], nil
}

// CellMatrix holds element-number child matrices in column-major order.
type CellMatrix struct {
	name     string
	dims     []int32
	children []Value
	src      Source
}

// Class returns ClassCell.
func (m *CellMatrix) Class() ValueClass { return ClassCell }

// Dims returns a copy of the dimension vector.
func (m *CellMatrix) Dims() []int32 {
	out := make([]int32, len(m.dims))
	copy(out, m.dims)
	return out
}

// Source returns the provenance of the matrix element.
func (m *CellMatrix) Source() Source { return m.src }

// NumElements returns the number of child slots.
func (m *CellMatrix) NumElements() uint64 { return uint64(len(m.children)) }

// At returns the child at the given linear column-major index.
func (m *CellMatrix) At(linearIndex int32) (Value, error) {
	if linearIndex < 0 || uint64(linearIndex) >= uint64(len(m.children)) {
		return nil, ErrIndex
	}
	return m.children[linearIndex], nil
}

// Scalar is one resolved numeric element.
type Scalar struct {
	Class   ValueClass
	Real    uint64 // raw double bit pattern, or zero-extended int32
	Imag    uint64 // raw double bit pattern; meaningful only when Complex
	Complex bool
}

// Int32 reinterprets Real as a signed int32.
func (s Scalar) Int32() int32 { return int32(uint32(s.Real)) }

// Variable is one published top-level matrix.
type Variable struct {
	Name  string
	Value Value
}

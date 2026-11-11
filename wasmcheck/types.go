package wasmcheck

const (
	wasmMagic   = "\x00asm"
	wasmVersion = 1
)

// Standard WebAssembly 1.0 section identifiers.
const (
	sectionCustom    = 0
	sectionType      = 1
	sectionImport    = 2
	sectionFunction  = 3
	sectionTable     = 4
	sectionMemory    = 5
	sectionGlobal    = 6
	sectionExport    = 7
	sectionStart     = 8
	sectionElement   = 9
	sectionCode      = 10
	sectionData      = 11
	sectionDataCount = 12
)

const (
	kindFunction = 0x00
	kindTable    = 0x01
	kindMemory   = 0x02
	kindGlobal   = 0x03
)

const (
	valTypeI32     = 0x7f
	valTypeI64     = 0x7e
	valTypeF32     = 0x7d
	valTypeF64     = 0x7c
	funcrefType    = 0x70
	externrefType  = 0x6f
	funcTypeMarker = 0x60
)

// FuncType is a concrete WebAssembly function type: value types are encoded
// with their binary value-type bytes (0x7f..0x6f), matching the wire format.
type FuncType struct {
	Params  []byte
	Results []byte
}

// AllowedImport describes one import the host is prepared to satisfy.
// Module and Field must be non-empty and FuncType must match the binary
// type of the imported function exactly.
type AllowedImport struct {
	Module   string
	Field    string
	FuncType FuncType
}

// Import records an accepted function import together with its resolved
// function index and type index.
type Import struct {
	Module    string
	Field     string
	FuncIndex uint32
	TypeIndex uint32
}

// Table describes one funcref table with its inclusive bounds.
type Table struct {
	Min uint32
	Max uint32
	// HasMax reports whether the table declares an upper bound.
	HasMax bool
}

// Export records one accepted export. Only function and table exports are
// permitted; Kind is either 0x00 (function) or 0x01 (table).
type Export struct {
	Name  string
	Kind  byte
	Index uint32
}

// ElementSegment is an MVP-style active element segment whose references
// are plain function indices.
type ElementSegment struct {
	TableIndex uint32
	// Offset holds the constant i32 initializer operand.
	Offset int32
	// FuncIndices are reachable function indices that fit the table type.
	FuncIndices []uint32
}

// Capabilities is the read-only capability summary handed back to the
// loader. Fields are unexported; use the accessor methods, which hand out
// defensive copies so caller-side mutation cannot change the summary.
type Capabilities struct {
	types        []FuncType
	imports      []Import
	definedFuncs []uint32
	tables       []Table
	exports      []Export
	elements     []ElementSegment
	importedFunc uint32
	totalFunc    uint32
}

// TypeCount returns the number of declared function types.
func (c *Capabilities) TypeCount() int { return len(c.types) }

// Type returns a copy of the function type at the given index.
func (c *Capabilities) Type(index int) FuncType {
	t := c.types[index]
	return FuncType{
		Params:  append([]byte(nil), t.Params...),
		Results: append([]byte(nil), t.Results...),
	}
}

// ImportedFunctionCount returns the number of imported functions; defined
// function indices start at this value.
func (c *Capabilities) ImportedFunctionCount() uint32 { return c.importedFunc }

// FunctionCount returns the total number of functions, imported plus
// defined.
func (c *Capabilities) FunctionCount() uint32 { return c.totalFunc }

// ImportCount returns the number of accepted imports.
func (c *Capabilities) ImportCount() int { return len(c.imports) }

// Import returns a copy of the import at the given position.
func (c *Capabilities) Import(index int) Import { return c.imports[index] }

// DefinedFunctionCount returns the number of functions defined in the
// module (function section entries).
func (c *Capabilities) DefinedFunctionCount() int { return len(c.definedFuncs) }

// DefinedFunctionType returns the type index of the defined function at the
// given position.
func (c *Capabilities) DefinedFunctionType(index int) uint32 {
	return c.definedFuncs[index]
}

// TableCount returns the number of funcref tables.
func (c *Capabilities) TableCount() int { return len(c.tables) }

// Table returns a copy of the table at the given index.
func (c *Capabilities) Table(index int) Table { return c.tables[index] }

// ExportCount returns the number of accepted exports.
func (c *Capabilities) ExportCount() int { return len(c.exports) }

// Export returns a copy of the export at the given position.
func (c *Capabilities) Export(index int) Export { return c.exports[index] }

// ExportByName looks up an export by name; ok is false when absent.
func (c *Capabilities) ExportByName(name string) (Export, bool) {
	for _, e := range c.exports {
		if e.Name == name {
			return e, true
		}
	}
	return Export{}, false
}

// ElementCount returns the number of active element segments.
func (c *Capabilities) ElementCount() int { return len(c.elements) }

// Element returns a copy of the element segment at the given position,
// including a defensive copy of its function indices.
func (c *Capabilities) Element(index int) ElementSegment {
	e := c.elements[index]
	e.FuncIndices = append([]uint32(nil), e.FuncIndices...)
	return e
}

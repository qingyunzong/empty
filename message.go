package dataeng

import "strings"

// Message is any item accepted by a Stream. The replay package understands
// SchemaMessage, DictionaryMessage and BatchMessage values, as well as pointers
// to them. A JSON object or JSON byte slice whose "type" (or "kind") field is
// "schema", "dictionary" or "batch" is also accepted.
type Message = any

// Column types understood by the replay package. Types are metadata carried
// through to results; values themselves are stored as interface values.
type ColumnType = string

const (
	TypeInt        ColumnType = "int"
	TypeInt8       ColumnType = "int8"
	TypeInt16      ColumnType = "int16"
	TypeInt32      ColumnType = "int32"
	TypeInt64      ColumnType = "int64"
	TypeUint       ColumnType = "uint"
	TypeUint8      ColumnType = "uint8"
	TypeUint16     ColumnType = "uint16"
	TypeUint32     ColumnType = "uint32"
	TypeUint64     ColumnType = "uint64"
	TypeFloat32    ColumnType = "float32"
	TypeFloat64    ColumnType = "float64"
	TypeString     ColumnType = "string"
	TypeBool       ColumnType = "bool"
	TypeBytes      ColumnType = "bytes"
	TypeBinary     ColumnType = "binary"
	TypeDecimal    ColumnType = "decimal"
	TypeDate       ColumnType = "date"
	TypeTime       ColumnType = "time"
	TypeTimestamp  ColumnType = "timestamp"
	TypeDictionary ColumnType = "dictionary"
)

// Column is one column declared by a stream's schema. DictionaryID is
// non-empty when the column is dictionary encoded. DictID is accepted as a
// spelling variant.
type Column struct {
	Name         string
	ColumnName   string
	Type         ColumnType
	Kind         ColumnType
	DictionaryID string
	DictID       string
	Dictionary   string
	Dict         string
}

// ColumnDefinition and SchemaColumn are aliases kept for callers that prefer
// to name the schema declaration explicitly.
type ColumnDefinition = Column
type SchemaColumn = Column
type ColumnDef = Column

func (c Column) name() string {
	if c.Name != "" {
		return c.Name
	}
	if c.ColumnName != "" {
		return c.ColumnName
	}
	return ""
}

func (c Column) typeName() ColumnType {
	if c.Type != "" {
		return c.Type
	}
	return c.Kind
}

func (c Column) dictionaryID() string {
	if c.DictionaryID != "" {
		return c.DictionaryID
	}
	if c.DictID != "" {
		return c.DictID
	}
	if c.Dictionary != "" {
		return c.Dictionary
	}
	return c.Dict
}

// SchemaMessage must be the first message on a stream and may occur exactly
// once. Columns is the canonical spelling; ColumnDefs is accepted as an alias.
type SchemaMessage struct {
	Columns     []Column
	ColumnDefs  []Column
	Definitions []Column
}

// Schema is an alias for SchemaMessage.
type Schema = SchemaMessage

func (m SchemaMessage) columns() []Column {
	if m.Columns != nil {
		return m.Columns
	}
	if m.ColumnDefs != nil {
		return m.ColumnDefs
	}
	return m.Definitions
}

// Dictionary modes. An empty mode is treated as DictionaryReplace, which is
// also the safe default for the zero-value message.
type DictionaryMode = string

const (
	DictionaryReplace DictionaryMode = "replace"
	DictionaryAppend  DictionaryMode = "append"
	ReplaceMode       DictionaryMode = "replace"
	AppendMode        DictionaryMode = "append"
	ModeReplace       DictionaryMode = "replace"
	ModeAppend        DictionaryMode = "append"

	// Replace and Append are the shortest spellings of the two dictionary
	// update modes.
	Replace = DictionaryReplace
	Append  = DictionaryAppend
)

// DictionaryMessage carries one generation of a dictionary. Values is the
// complete item list for a replacement and the newly appended suffix for an
// append. Entries and Items are accepted aliases for Values.
//
// Replace and Append booleans are convenience switches. Operation and Mode may
// also hold "replace" or "append".
type DictionaryMessage struct {
	ID           string
	DictionaryID string
	DictID       string
	Key          string
	Generation   int
	Gen          int
	Version      int
	Mode         DictionaryMode
	Operation    string
	Replace      bool
	Append       bool
	Values       any
	Entries      any
	Items        any
	Data         any
}

// Dictionary, Dict and DictionaryUpdate are aliases for DictionaryMessage.
type Dictionary = DictionaryMessage
type Dict = DictionaryMessage
type DictionaryUpdate = DictionaryMessage

func (m DictionaryMessage) dictionaryID() string {
	if m.ID != "" {
		return m.ID
	}
	if m.DictionaryID != "" {
		return m.DictionaryID
	}
	if m.DictID != "" {
		return m.DictID
	}
	return m.Key
}

func (m DictionaryMessage) generation() int {
	if m.Generation != 0 {
		return m.Generation
	}
	if m.Gen != 0 {
		return m.Gen
	}
	return m.Version
}

func (m DictionaryMessage) mode() (DictionaryMode, bool) {
	if m.Operation != "" {
		return normalizeMode(m.Operation)
	}
	if m.Mode != "" {
		return normalizeMode(m.Mode)
	}
	if m.Append {
		return DictionaryAppend, true
	}
	return DictionaryReplace, true
}

func normalizeMode(mode string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "a", "add", "append", "delta", "suffix", "extend", "patch":
		return DictionaryAppend, true
	case "", "r", "replace", "full", "reset", "snapshot", "overwrite":
		return DictionaryReplace, true
	default:
		return "", false
	}
}

func (m DictionaryMessage) rawValues() any {
	if m.Values != nil {
		return m.Values
	}
	if m.Entries != nil {
		return m.Entries
	}
	if m.Items != nil {
		return m.Items
	}
	return m.Data
}

// ColumnBatch is one column vector inside a BatchMessage. For dictionary
// encoded columns Indices holds the dictionary indices; -1 represents null. For
// ordinary columns Values holds the already decoded values. Both fields are
// interface values so []int, []int64, []string, []any and similar slices are
// accepted and converted by the replay engine.
type ColumnBatch struct {
	Name         string
	ColumnName   string
	Column       string
	DictionaryID string
	DictID       string
	Generation   int
	Gen          int
	Indices      any
	Index        any
	Values       any
	Entries      any
}

func (c ColumnBatch) name() string {
	switch {
	case c.Name != "":
		return c.Name
	case c.ColumnName != "":
		return c.ColumnName
	default:
		return c.Column
	}
}

func (c ColumnBatch) rawIndices() any {
	if c.Indices != nil {
		return c.Indices
	}
	return c.Index
}

func (c ColumnBatch) rawValues() any {
	if c.Values != nil {
		return c.Values
	}
	return c.Entries
}

func (c ColumnBatch) generation() int {
	if c.Generation != 0 {
		return c.Generation
	}
	return c.Gen
}

// BatchMessage is a group of column vectors. Generations (also accepted as
// RequiredGenerations, DictionaryGenerations or Required) maps every referenced
// dictionary ID to the generation against which its indices must be decoded.
// Columns may be a []ColumnBatch, []*ColumnBatch, a map from column name to a
// slice, or a []any containing ColumnBatch values.
//
// Rows, Indices and Values are alternative compact spellings. A batch may
// contain a subset of the schema columns; this supports interleaved column
// batches.
type BatchMessage struct {
	Sequence              int
	Generations           any
	RequiredGenerations   any
	DictionaryGenerations any
	DictionaryVersions    any
	Required              any
	Dictionaries          any
	Columns               any
	ColumnBatches         any
	ColumnData            any
	Data                  any
	Rows                  any
	Indices               any
	Values                any
}

// Batch and RecordBatch are aliases for BatchMessage.
type Batch = BatchMessage
type RecordBatch = BatchMessage

// NewBatch is a small convenience constructor.
func NewBatch(generations map[string]int, columns ...ColumnBatch) BatchMessage {
	return BatchMessage{Generations: generations, Columns: columns}
}

// NewColumnBatch is a small convenience constructor for dictionary indices.
func NewColumnBatch(name string, indices []int) ColumnBatch {
	return ColumnBatch{Name: name, Indices: indices}
}

// NewDictionary builds a dictionary replacement or append message.
func NewDictionary(id string, generation int, mode DictionaryMode, values ...any) DictionaryMessage {
	return DictionaryMessage{ID: id, Generation: generation, Mode: mode, Values: values}
}

// NewSchema builds a schema message from column definitions.
func NewSchema(columns ...Column) SchemaMessage {
	return SchemaMessage{Columns: columns}
}

// ResolvedColumn is one decoded column vector in a Result.
type ResolvedColumn struct {
	Name         string
	Type         ColumnType
	DictionaryID string
	Generation   int
	Values       []any
}

// Result is a successfully decoded batch. Values in Columns and Rows are
// independent copies: later dictionary replacements or appends cannot mutate
// an already returned Result.
type Result struct {
	Sequence int
	Columns  []ResolvedColumn
	Rows     [][]any
	Batch    *BatchMessage
}

// Column returns a decoded column by name.
func (r Result) Column(name string) (ResolvedColumn, bool) {
	for _, column := range r.Columns {
		if column.Name == name {
			return column, true
		}
	}
	return ResolvedColumn{}, false
}

// Values returns the decoded values of a named column.
func (r Result) Values(name string) ([]any, bool) {
	column, ok := r.Column(name)
	if !ok {
		return nil, false
	}
	return column.Values, true
}

// Value returns one decoded cell.
func (r Result) Value(row int, column string) (any, bool) {
	col, ok := r.Column(column)
	if !ok || row < 0 || row >= len(col.Values) {
		return nil, false
	}
	return col.Values[row], true
}

// Record returns row as a map keyed by column name.
func (r Result) Record(row int) (map[string]any, bool) {
	if row < 0 || row >= len(r.Rows) {
		return nil, false
	}
	record := make(map[string]any, len(r.Columns))
	for _, column := range r.Columns {
		if row < len(column.Values) {
			record[column.Name] = column.Values[row]
		}
	}
	return record, true
}

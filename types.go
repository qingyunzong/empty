package dataeng

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ColumnType is the logical MySQL type of a column.
//
// The zero value is TypeUnknown. Type names are case-insensitive when they are
// used to build a Column; see CanonicalColumnType.
type ColumnType string

const (
	TypeUnknown   ColumnType = ""
	TypeNull      ColumnType = "null"
	TypeTinyInt   ColumnType = "tinyint"
	TypeSmallInt  ColumnType = "smallint"
	TypeMediumInt ColumnType = "mediumint"
	TypeInt       ColumnType = "int"
	TypeBigInt    ColumnType = "bigint"
	TypeDecimal   ColumnType = "decimal"
	TypeFloat     ColumnType = "float"
	TypeDouble    ColumnType = "double"
	TypeBit       ColumnType = "bit"
	TypeDate      ColumnType = "date"
	TypeTime      ColumnType = "time"
	TypeDateTime  ColumnType = "datetime"
	TypeTimestamp ColumnType = "timestamp"
	TypeYear      ColumnType = "year"
	TypeChar      ColumnType = "char"
	TypeVarChar   ColumnType = "varchar"
	TypeBinary    ColumnType = "binary"
	TypeVarBinary ColumnType = "varbinary"
	TypeText      ColumnType = "text"
	TypeBlob      ColumnType = "blob"
	TypeEnum      ColumnType = "enum"
	TypeSet       ColumnType = "set"
	TypeJSON      ColumnType = "json"
	TypeGeometry  ColumnType = "geometry"
)

var columnTypeAliases = map[string]ColumnType{
	"":                   TypeUnknown,
	"null":               TypeNull,
	"tinyint":            TypeTinyInt,
	"tiny":               TypeTinyInt,
	"int1":               TypeTinyInt,
	"smallint":           TypeSmallInt,
	"short":              TypeSmallInt,
	"int2":               TypeSmallInt,
	"mediumint":          TypeMediumInt,
	"middleint":          TypeMediumInt,
	"int24":              TypeMediumInt,
	"int":                TypeInt,
	"integer":            TypeInt,
	"int4":               TypeInt,
	"long":               TypeInt,
	"bigint":             TypeBigInt,
	"longlong":           TypeBigInt,
	"int8":               TypeBigInt,
	"decimal":            TypeDecimal,
	"numeric":            TypeDecimal,
	"newdecimal":         TypeDecimal,
	"float":              TypeFloat,
	"double":             TypeDouble,
	"real":               TypeDouble,
	"bit":                TypeBit,
	"date":               TypeDate,
	"time":               TypeTime,
	"datetime":           TypeDateTime,
	"timestamp":          TypeTimestamp,
	"year":               TypeYear,
	"char":               TypeChar,
	"string":             TypeChar,
	"varchar":            TypeVarChar,
	"varstring":          TypeVarChar,
	"binary":             TypeBinary,
	"varbinary":          TypeVarBinary,
	"text":               TypeText,
	"tinytext":           TypeText,
	"mediumtext":         TypeText,
	"longtext":           TypeText,
	"blob":               TypeBlob,
	"tinyblob":           TypeBlob,
	"mediumblob":         TypeBlob,
	"longblob":           TypeBlob,
	"enum":               TypeEnum,
	"set":                TypeSet,
	"json":               TypeJSON,
	"geometry":           TypeGeometry,
	"point":              TypeGeometry,
	"linestring":         TypeGeometry,
	"polygon":            TypeGeometry,
	"multipoint":         TypeGeometry,
	"multilinestring":    TypeGeometry,
	"multipolygon":       TypeGeometry,
	"geometrycollection": TypeGeometry,
}

// CanonicalColumnType normalises aliases and casing. Unknown names are
// returned in lower case so that they remain usable for diagnostic output.
func CanonicalColumnType(t ColumnType) ColumnType {
	s := strings.ToLower(strings.TrimSpace(string(t)))
	if open := strings.IndexByte(s, '('); open >= 0 {
		s = strings.TrimSpace(s[:open])
	}
	s = strings.ReplaceAll(s, " unsigned", "")
	s = strings.ReplaceAll(s, "unsigned ", "")
	s = strings.ReplaceAll(s, " zerofill", "")
	s = strings.TrimSpace(s)
	if canonical, ok := columnTypeAliases[s]; ok {
		return canonical
	}
	return ColumnType(s)
}

// ParseColumnType parses a MySQL type declaration such as "BIGINT(20)
// UNSIGNED" and reports whether it is unsigned.
func ParseColumnType(t ColumnType) (ColumnType, bool) {
	text := strings.ToLower(strings.TrimSpace(string(t)))
	unsigned := strings.Contains(text, "unsigned")
	return CanonicalColumnType(t), unsigned
}

// IntegerWidth returns the storage width, in bits, of an integer column.
// The boolean result is false for non-integer types.
func (t ColumnType) IntegerWidth() (int, bool) {
	switch CanonicalColumnType(t) {
	case TypeTinyInt:
		return 8, true
	case TypeSmallInt:
		return 16, true
	case TypeMediumInt:
		return 24, true
	case TypeInt:
		return 32, true
	case TypeBigInt:
		return 64, true
	default:
		return 0, false
	}
}

// IsInteger reports whether t is one of MySQL's integer types.
func (t ColumnType) IsInteger() bool {
	_, ok := t.IntegerWidth()
	return ok
}

// MySQLColumnType maps a MySQL protocol/binlog column type byte to a
// ColumnType. It is useful when adapting a binlog decoder's TABLE_MAP event.
func MySQLColumnType(code byte) ColumnType {
	switch code {
	case 0:
		return TypeDecimal
	case 1:
		return TypeTinyInt
	case 2:
		return TypeSmallInt
	case 3:
		return TypeInt
	case 4:
		return TypeFloat
	case 5:
		return TypeDouble
	case 6:
		return TypeNull
	case 7, 17:
		return TypeTimestamp
	case 8:
		return TypeBigInt
	case 9:
		return TypeMediumInt
	case 10, 14:
		return TypeDate
	case 11, 19:
		return TypeTime
	case 12, 18:
		return TypeDateTime
	case 13:
		return TypeYear
	case 15, 253:
		return TypeVarChar
	case 16:
		return TypeBit
	case 245:
		return TypeJSON
	case 246:
		return TypeGeometry
	case 247:
		return TypeEnum
	case 248:
		return TypeSet
	case 249, 250, 251, 252:
		return TypeBlob
	case 254:
		return TypeChar
	default:
		return TypeUnknown
	}
}

// ColumnTypeFromMySQL is an alias for MySQLColumnType.
func ColumnTypeFromMySQL(code byte) ColumnType {
	return MySQLColumnType(code)
}

// Column describes one column in a TABLE_MAP generation.
type Column struct {
	Name       string
	Type       ColumnType
	Unsigned   bool
	Nullable   bool
	PrimaryKey bool

	// Optional metadata carried through for consumers that need the original
	// binlog definition. They do not participate in identity comparison unless
	// they affect row representation.
	Charset     string
	Collation   string
	Precision   int
	Scale       int
	Length      int
	EnumValues  []string
	SetValues   []string
	MySQLType   byte
	ColumnIndex int

	// PartialJSON marks a JSON column whose row image may contain a MySQL
	// partial-JSON diff instead of a complete JSON document.
	PartialJSON bool
}

// CanonicalType returns the normalised type name.
func (c Column) CanonicalType() ColumnType {
	return CanonicalColumnType(c.Type)
}

// IsJSON reports whether the column stores a JSON document.
func (c Column) IsJSON() bool {
	return c.CanonicalType() == TypeJSON
}

// IsInteger reports whether the column stores an integer.
func (c Column) IsInteger() bool {
	return c.CanonicalType().IsInteger()
}

// TableMap is a TABLE_MAP event together with the generation assigned by the
// schema registry. A generation identifies one immutable layout of a logical
// table (schema + table name). Old generations are never used to decode rows
// after DDL.
type TableMap struct {
	TableID  uint64
	TableId  uint64
	Schema   string
	Database string
	Table    string
	Columns  []Column

	// ColumnNames/ColumnTypes/UnsignedMap are convenience fields for adapters
	// that receive the binlog TABLE_MAP as parallel arrays. They are expanded
	// into Columns when Columns is empty.
	ColumnNames []string
	ColumnTypes []ColumnType
	UnsignedMap []bool

	// PrimaryKey lists the column names that identify a row. Any of the three
	// spellings may be used by callers; the pipeline treats them as one list.
	PrimaryKey        []string
	PrimaryKeyColumns []string
	PKColumns         []string
	PK                []string
	KeyColumns        []string

	// Generation and Fingerprint are filled in by SchemaRegistry.Register.
	Generation  uint64
	Fingerprint string
}

// TableMapEvent is an alias kept for callers that name the event explicitly.
type TableMapEvent = TableMap

// TableMapGeneration is an alias for TableMap. Its Generation field identifies
// one immutable layout generation.
type TableMapGeneration = TableMap

// TableIdentity is the logical identity of a table.
type TableIdentity struct {
	Schema string `json:"schema"`
	Table  string `json:"table"`
}

func (t TableIdentity) String() string {
	if t.Schema == "" {
		return t.Table
	}
	return t.Schema + "." + t.Table
}

func (t TableIdentity) key() string {
	return t.Schema + "\x00" + t.Table
}

// Identity returns the logical table identity.
func (m TableMap) Identity() TableIdentity {
	return TableIdentity{Schema: m.Schema, Table: m.Table}
}

// Column returns the named column. Column names are matched
// case-insensitively, mirroring MySQL's identifier rules.
func (m TableMap) Column(name string) (Column, bool) {
	for _, c := range m.Columns {
		if strings.EqualFold(c.Name, name) {
			return c, true
		}
	}
	return Column{}, false
}

// ResolvedKeyColumns returns the effective primary-key column names. Explicit
// key lists win over per-column PrimaryKey flags.
func (m TableMap) ResolvedKeyColumns() []string {
	for _, list := range [][]string{m.PrimaryKey, m.PrimaryKeyColumns, m.PKColumns, m.PK, m.KeyColumns} {
		if len(list) > 0 {
			out := make([]string, 0, len(list))
			for _, name := range list {
				if name != "" {
					out = append(out, name)
				}
			}
			if len(out) > 0 {
				return out
			}
		}
	}
	var out []string
	for _, c := range m.Columns {
		if c.PrimaryKey {
			out = append(out, c.Name)
		}
	}
	return out
}

// SortKeyColumns returns a stable, duplicate-free key column list.
func (m TableMap) SortKeyColumns() []string {
	keys := m.ResolvedKeyColumns()
	sort.Strings(keys)
	return dedupeStrings(keys)
}

func (m TableMap) clone() TableMap {
	out := m
	out.Columns = append([]Column(nil), m.Columns...)
	out.ColumnNames = append([]string(nil), m.ColumnNames...)
	out.ColumnTypes = append([]ColumnType(nil), m.ColumnTypes...)
	out.UnsignedMap = append([]bool(nil), m.UnsignedMap...)
	out.PrimaryKey = append([]string(nil), m.PrimaryKey...)
	out.PrimaryKeyColumns = append([]string(nil), m.PrimaryKeyColumns...)
	out.PKColumns = append([]string(nil), m.PKColumns...)
	out.PK = append([]string(nil), m.PK...)
	out.KeyColumns = append([]string(nil), m.KeyColumns...)
	return out
}

// RowImage represents a row image received from the binlog.
//
// Its most important property is that a column that was not present in the
// event is different from a column whose SQL value is NULL: the former is
// absent from the map, while the latter is present with a nil value. MINIMAL
// row images rely on this distinction and the pipeline never invents zero
// values for absent columns.
type RowImage map[string]any

// Has reports whether a column was present in the image, including NULL.
func (r RowImage) Has(name string) bool {
	_, ok := r.Get(name)
	return ok
}

// Get returns the value and whether the column was present. If there is no
// exact match, a case-insensitive match is attempted.
func (r RowImage) Get(name string) (any, bool) {
	if r == nil {
		return nil, false
	}
	if v, ok := r[name]; ok {
		return v, true
	}
	for k, v := range r {
		if strings.EqualFold(k, name) {
			return v, true
		}
	}
	return nil, false
}

// Clone returns a shallow copy of the image.
func (r RowImage) Clone() RowImage {
	if r == nil {
		return nil
	}
	out := make(RowImage, len(r))
	for k, v := range r {
		out[k] = v
	}
	return out
}

// Canonical returns a copy whose keys use the column names from the table map.
// Unknown columns are preserved verbatim.
func (r RowImage) Canonical(m TableMap) RowImage {
	out := make(RowImage, len(r))
	for k, v := range r {
		name := k
		if c, ok := m.Column(k); ok {
			name = c.Name
		}
		out[name] = v
	}
	return out
}

// RowEventType is the DML operation represented by a row event.
type RowEventType string

const (
	RowInsert RowEventType = "insert"
	RowUpdate RowEventType = "update"
	RowDelete RowEventType = "delete"

	// Upper-case aliases are accepted by the pipeline as well.
	RowInsertUpper RowEventType = "INSERT"
	RowUpdateUpper RowEventType = "UPDATE"
	RowDeleteUpper RowEventType = "DELETE"
)

// EventType is an alias for callers that call the DML operation an event type.
type EventType = RowEventType

func canonicalRowEventType(t RowEventType) RowEventType {
	switch strings.ToLower(strings.TrimSpace(string(t))) {
	case "insert", "write", "create":
		return RowInsert
	case "update", "modify":
		return RowUpdate
	case "delete", "remove":
		return RowDelete
	default:
		return RowEventType(strings.ToLower(string(t)))
	}
}

// RowEvent is one WRITE/UPDATE/DELETE row event or one half of a
// WRITE_ROWS/UPDATE_ROWS/DELETE_ROWS event pair.
//
// Before is the pre-image and After is the post-image. Under
// binlog_row_image=MINIMAL either image may contain only the columns that
// changed (plus the primary key). Absent columns are deliberately represented
// by missing map entries, not by zero values.
type RowEvent struct {
	Type        RowEventType
	Operation   RowEventType
	EventType   RowEventType
	TableID     uint64
	TableId     uint64
	Schema      string
	Table       string
	Before      RowImage
	After       RowImage
	BeforeImage RowImage
	AfterImage  RowImage
	RowKey      RowImage
	Timestamp   uint64
	LogPosition uint64

	// JSONDiffs supplies partial-JSON diffs explicitly. The maps are keyed by
	// column name. A diff may also be put directly in Before/After as a
	// JSONDiff value.
	BeforeJSONDiffs map[string]JSONDiff
	AfterJSONDiffs  map[string]JSONDiff

	// PartialJSON asks the pipeline to interpret byte slices in JSON columns as
	// MySQL binary partial-JSON diffs. Prefer JSONDiff for explicit input.
	PartialJSON bool
}

// Event is anything that can appear in a transaction payload.
type Event interface {
	isBinlogEvent()
}

func (TableMap) isBinlogEvent() {}
func (RowEvent) isBinlogEvent() {}
func (DDLEvent) isBinlogEvent() {}

// NormalizedRow is a row reconstructed from a row event.
//
// Row is the final state (After for INSERT/UPDATE, Before for DELETE). It
// contains every column that could be reconstructed. MissingColumns lists the
// columns whose values are genuinely unknown; they are not zero-filled. When
// MissingColumns is non-empty Reconstructable is false (and Complete is false
// as a compatibility alias).
type NormalizedRow struct {
	Type       RowEventType
	Schema     string
	Table      string
	TableID    uint64
	Generation uint64

	PrimaryKey map[string]any
	Before     RowImage
	After      RowImage
	Row        RowImage

	MissingColumns []string
	MissingBefore  []string
	MissingAfter   []string
	Missing        []string

	Reconstructable       bool
	Reconstructible       bool // spelling compatibility alias
	Rebuildable           bool
	Complete              bool
	CanReconstruct        bool
	BeforeReconstructable bool
	AfterReconstructable  bool

	// BaseVersion is the version of the stored pre-image used for completion;
	// Version is the version written for the resulting row. Zero means no
	// stored image was involved.
	BaseVersion uint64
	Version     uint64

	Warnings []string
}

func (r *NormalizedRow) setCompleteness() {
	r.Complete = r.Reconstructable
	r.Rebuildable = r.Reconstructable
	r.Reconstructible = r.Reconstructable
	r.CanReconstruct = r.Reconstructable
	r.Missing = append([]string(nil), r.MissingColumns...)
}

// NormalizedRowImage is an alias for NormalizedRow.
type NormalizedRowImage = NormalizedRow

// NormalizedEvent is one processed item in a transaction, in input order.
type NormalizedEvent struct {
	Kind     string
	TableMap *TableMap
	DDL      *DDLEvent
	Row      *NormalizedRow
	Err      error
}

// Transaction is a transaction payload. Events are applied in order.
//
// TableMaps, Rows and DDLs are convenience fields for adapters that receive
// the payload in separate slices. They are processed after Events, in that
// order.
type Transaction struct {
	GTID      string
	Events    []Event
	Payload   []Event
	TableMaps []TableMap
	Rows      []RowEvent
	DDLs      []DDLEvent
}

// TransactionPayload is an alias for Transaction.
type TransactionPayload = Transaction

// BinlogTransaction is an alias for Transaction.
type BinlogTransaction = Transaction

// TxPayload is an alias for Transaction.
type TxPayload = Transaction

// NewTransaction builds a transaction from a heterogeneous event list.
func NewTransaction(events ...Event) Transaction {
	return Transaction{Events: events}
}

// TransactionResult is the normalised output of a transaction payload.
type TransactionResult struct {
	GTID      string
	Events    []NormalizedEvent
	Rows      []NormalizedRow
	TableMaps []TableMap
	DDLs      []DDLEvent
	Errors    []error

	AllReconstructable bool
	AllRowsComplete    bool
}

// Complete reports whether all row events in the transaction were
// reconstructable and no event failed.
func (r TransactionResult) Complete() bool {
	if len(r.Errors) > 0 {
		return false
	}
	for _, row := range r.Rows {
		if !row.Reconstructable {
			return false
		}
	}
	return true
}

// Identity returns the row's logical table identity.
func (r NormalizedRow) Identity() TableIdentity {
	return TableIdentity{Schema: r.Schema, Table: r.Table}
}

func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func canonicalJSONValue(v any) any {
	switch typed := v.(type) {
	case json.RawMessage:
		var out any
		if err := json.Unmarshal(typed, &out); err == nil {
			return out
		}
	case []byte:
		var out any
		if err := json.Unmarshal(typed, &out); err == nil {
			return out
		}
	}
	return v
}

func jsonEqual(a, b any) bool {
	aa, errA := json.Marshal(canonicalJSONValue(a))
	bb, errB := json.Marshal(canonicalJSONValue(b))
	if errA != nil || errB != nil {
		return fmt.Sprintf("%#v", a) == fmt.Sprintf("%#v", b)
	}
	return bytes.Equal(aa, bb)
}

package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// DDLKind identifies the DDL operation carried by a DDLEvent.
type DDLKind string

const (
	DDLUnknown  DDLKind = ""
	DDLCreate   DDLKind = "create"
	DDLAlter    DDLKind = "alter"
	DDLDrop     DDLKind = "drop"
	DDLRename   DDLKind = "rename"
	DDLTruncate DDLKind = "truncate"
)

// String implements fmt.Stringer.
func (k DDLKind) String() string { return string(k) }

// TableChange is one old/new table pair in a DDL event.
type TableChange struct {
	Old TableIdentity
	New TableIdentity
}

// DDLEvent invalidates TABLE_MAP generations. Any DDL that can change a
// table's layout must be delivered before rows of the new generation; the
// registry removes the old TABLE_MAP association immediately.
type DDLEvent struct {
	Kind      DDLKind
	Type      DDLKind
	Operation DDLKind
	Schema    string
	Table     string

	OldSchema string
	OldTable  string
	NewSchema string
	NewTable  string

	Affected []TableIdentity
	Changes  []TableChange

	Query       string
	Timestamp   uint64
	LogPosition uint64
}

// AffectedTables returns every table identity the DDL invalidates.
func (d DDLEvent) AffectedTables() []TableIdentity {
	var out []TableIdentity
	out = append(out, d.Affected...)
	for _, change := range d.Changes {
		if change.Old.Table != "" {
			out = append(out, change.Old)
		}
		if change.New.Table != "" {
			out = append(out, change.New)
		}
	}
	if d.Schema != "" || d.Table != "" {
		out = append(out, TableIdentity{Schema: d.Schema, Table: d.Table})
	}
	if d.OldSchema != "" || d.OldTable != "" {
		out = append(out, TableIdentity{Schema: d.OldSchema, Table: d.OldTable})
	}
	if d.NewSchema != "" || d.NewTable != "" {
		out = append(out, TableIdentity{Schema: d.NewSchema, Table: d.NewTable})
	}

	seen := make(map[string]struct{}, len(out))
	deduped := out[:0]
	for _, identity := range out {
		if identity.Schema == "" && identity.Table == "" {
			continue
		}
		key := identity.key()
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, identity)
	}
	return deduped
}

var errInvalidTableMap = errors.New("dataeng: invalid table map")

// ErrUnknownTableMap is returned when a row event references a table ID for
// which no TABLE_MAP has been observed.
var ErrUnknownTableMap = errors.New("dataeng: unknown table id")

// ErrTableMapNotFound is an alias for ErrUnknownTableMap.
var ErrTableMapNotFound = ErrUnknownTableMap

// ErrStaleTableMap is returned when a row event references a TABLE_MAP that
// was invalidated by DDL.
var ErrStaleTableMap = errors.New("dataeng: stale table map generation")

// ErrStaleGeneration is an alias for ErrStaleTableMap.
var ErrStaleGeneration = ErrStaleTableMap

// ErrNotReconstructable is returned by helpers that require a complete row.
var ErrNotReconstructable = errors.New("dataeng: row is not reconstructable")

// ErrTableMapMismatch is returned when an event's explicit schema/table does
// not match the TABLE_MAP resolved from its table ID.
var ErrTableMapMismatch = errors.New("dataeng: event table does not match table map")

// StaleTableMapError gives details for a row that arrived after DDL but before
// a fresh TABLE_MAP.
type StaleTableMapError struct {
	TableID    uint64
	Identity   TableIdentity
	Generation uint64
	Epoch      uint64
}

func (e *StaleTableMapError) Error() string {
	return fmt.Sprintf("%v: table_id=%d table=%s generation=%d ddl_epoch=%d",
		ErrStaleTableMap, e.TableID, e.Identity.String(), e.Generation, e.Epoch)
}

func (e *StaleTableMapError) Unwrap() error { return ErrStaleTableMap }

type activeMapping struct {
	identity    TableIdentity
	fingerprint string
	generation  uint64
	tableMap    TableMap
}

// SchemaRegistry tracks TABLE_MAP generations. It is safe for concurrent use.
//
// A generation belongs to a logical table, not to a table ID: MySQL can reuse
// table IDs, and a DDL statement makes every mapping for that table stale at
// once. Rows that reference a stale ID fail with ErrStaleTableMap until the
// next TABLE_MAP event creates a new generation.
type SchemaRegistry struct {
	mu sync.RWMutex

	active      map[uint64]*activeMapping
	byTable     map[string]*activeMapping
	latestGen   map[string]uint64
	lastFinger  map[string]string
	invalidated map[string]bool
	staleIDs    map[uint64]TableIdentity
	ddlEpoch    uint64
}

// TableMapRegistry is an alias for SchemaRegistry.
type TableMapRegistry = SchemaRegistry

// NewSchemaRegistry creates an empty registry.
func NewSchemaRegistry() *SchemaRegistry {
	return &SchemaRegistry{
		active:      make(map[uint64]*activeMapping),
		byTable:     make(map[string]*activeMapping),
		latestGen:   make(map[string]uint64),
		lastFinger:  make(map[string]string),
		invalidated: make(map[string]bool),
		staleIDs:    make(map[uint64]TableIdentity),
	}
}

// NewTableMapRegistry is an alias for NewSchemaRegistry.
func NewTableMapRegistry() *SchemaRegistry {
	return NewSchemaRegistry()
}

// NewTableMapFromBinlog expands parallel decoded TABLE_MAP arrays into a
// TableMap.
func NewTableMapFromBinlog(tableID uint64, schema, table string, names []string, types []ColumnType, unsigned []bool, keyColumns ...string) TableMap {
	return TableMap{
		TableID:     tableID,
		Schema:      schema,
		Table:       table,
		ColumnNames: append([]string(nil), names...),
		ColumnTypes: append([]ColumnType(nil), types...),
		UnsignedMap: append([]bool(nil), unsigned...),
		PrimaryKey:  append([]string(nil), keyColumns...),
	}
}

// NewTableMapFromMySQLTypes is like NewTableMapFromBinlog but accepts the
// MySQL protocol/binlog type bytes directly.
func NewTableMapFromMySQLTypes(tableID uint64, schema, table string, names []string, types []byte, unsigned []bool, keyColumns ...string) TableMap {
	converted := make([]ColumnType, len(types))
	for i, code := range types {
		converted[i] = MySQLColumnType(code)
	}
	return NewTableMapFromBinlog(tableID, schema, table, names, converted, unsigned, keyColumns...)
}

func (r *SchemaRegistry) ensureInit() {
	if r.active == nil {
		r.active = make(map[uint64]*activeMapping)
	}
	if r.byTable == nil {
		r.byTable = make(map[string]*activeMapping)
	}
	if r.latestGen == nil {
		r.latestGen = make(map[string]uint64)
	}
	if r.lastFinger == nil {
		r.lastFinger = make(map[string]string)
	}
	if r.invalidated == nil {
		r.invalidated = make(map[string]bool)
	}
	if r.staleIDs == nil {
		r.staleIDs = make(map[uint64]TableIdentity)
	}
}

// NewTableMap builds a table map and fills in per-column primary-key markers
// from keyColumns.
func NewTableMap(tableID uint64, schema, table string, columns []Column, keyColumns ...string) TableMap {
	keyNames := make(map[string]struct{}, len(keyColumns))
	for _, name := range keyColumns {
		keyNames[strings.ToLower(name)] = struct{}{}
	}
	out := TableMap{
		TableID:    tableID,
		Schema:     schema,
		Table:      table,
		Columns:    append([]Column(nil), columns...),
		PrimaryKey: append([]string(nil), keyColumns...),
	}
	for i := range out.Columns {
		if _, ok := keyNames[strings.ToLower(out.Columns[i].Name)]; ok {
			out.Columns[i].PrimaryKey = true
		}
	}
	return out
}

// Register validates a TABLE_MAP and assigns its generation.
func (r *SchemaRegistry) Register(tm TableMap) (TableMap, error) {
	normalized, fingerprint, identity, err := normalizeTableMap(tm)
	if err != nil {
		return TableMap{}, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureInit()

	key := identity.key()
	generation := r.latestGen[key]
	if generation == 0 {
		generation = 1
	}

	if r.invalidated[key] {
		// Invalidate already advanced the generation. Reuse that number for
		// the first TABLE_MAP after DDL.
		r.invalidated[key] = false
	} else if previous, ok := r.byTable[key]; ok && previous.fingerprint != fingerprint {
		generation++
	} else if previousFingerprint, ok := r.lastFinger[key]; ok && previousFingerprint != fingerprint {
		generation++
	}

	normalized.Generation = generation
	normalized.Fingerprint = fingerprint

	// A table ID may be reclaimed from another table. Drop the old active
	// association rather than leaving a map under an ID MySQL no longer uses.
	if old, ok := r.active[normalized.TableID]; ok {
		if old.identity != identity {
			delete(r.byTable, old.identity.key())
		}
	}

	mapping := &activeMapping{
		identity:    identity,
		fingerprint: fingerprint,
		generation:  generation,
		tableMap:    normalized.clone(),
	}
	r.active[normalized.TableID] = mapping
	r.byTable[key] = mapping
	r.latestGen[key] = generation
	r.lastFinger[key] = fingerprint
	delete(r.staleIDs, normalized.TableID)

	return normalized.clone(), nil
}

// ApplyTableMap is an alias for Register.
func (r *SchemaRegistry) ApplyTableMap(tm TableMap) (TableMap, error) {
	return r.Register(tm)
}

// Resolve returns the active TABLE_MAP for a table ID.
func (r *SchemaRegistry) Resolve(tableID uint64) (TableMap, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if mapping, ok := r.active[tableID]; ok {
		return mapping.tableMap.clone(), nil
	}
	if identity, stale := r.staleIDs[tableID]; stale {
		return TableMap{}, &StaleTableMapError{
			TableID:    tableID,
			Identity:   identity,
			Generation: r.latestGen[identity.key()],
			Epoch:      r.ddlEpoch,
		}
	}
	return TableMap{}, fmt.Errorf("%w: %d", ErrUnknownTableMap, tableID)
}

// Lookup is an alias for Resolve.
func (r *SchemaRegistry) Lookup(tableID uint64) (TableMap, error) {
	return r.Resolve(tableID)
}

// ResolveTable returns the latest active TABLE_MAP for a logical table. If
// schema is empty, the table name must identify exactly one active table.
func (r *SchemaRegistry) ResolveTable(schema, table string) (TableMap, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if schema != "" {
		if mapping, ok := r.byTable[TableIdentity{Schema: schema, Table: table}.key()]; ok {
			return mapping.tableMap.clone(), nil
		}
		return TableMap{}, fmt.Errorf("%w: %s.%s", ErrUnknownTableMap, schema, table)
	}

	var found *activeMapping
	for _, mapping := range r.byTable {
		if !strings.EqualFold(mapping.identity.Table, table) {
			continue
		}
		if found != nil {
			return TableMap{}, fmt.Errorf("%w: table name %q is ambiguous; schema is required", ErrUnknownTableMap, table)
		}
		found = mapping
	}
	if found == nil {
		return TableMap{}, fmt.Errorf("%w: table %q", ErrUnknownTableMap, table)
	}
	return found.tableMap.clone(), nil
}

// Generation returns the latest generation number for a logical table.
func (r *SchemaRegistry) Generation(schema, table string) uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.latestGen[TableIdentity{Schema: schema, Table: table}.key()]
}

// Epoch returns the number of DDL invalidations observed by the registry.
func (r *SchemaRegistry) Epoch() uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.ddlEpoch
}

// Invalidate immediately removes every active TABLE_MAP for the identities.
// It returns the number of table-ID mappings that were invalidated.
func (r *SchemaRegistry) Invalidate(identities ...TableIdentity) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureInit()

	type target struct {
		schema string
		table  string
	}
	targets := make([]target, 0, len(identities))
	for _, identity := range identities {
		if identity.Schema == "" && identity.Table == "" {
			continue
		}
		targets = append(targets, target{schema: identity.Schema, table: identity.Table})
	}
	if len(targets) == 0 {
		return 0
	}

	matches := func(identity TableIdentity) bool {
		for _, candidate := range targets {
			if !strings.EqualFold(identity.Table, candidate.table) {
				continue
			}
			if candidate.schema == "" || strings.EqualFold(identity.Schema, candidate.schema) {
				return true
			}
		}
		return false
	}

	count := 0
	for tableID, mapping := range r.active {
		if !matches(mapping.identity) {
			continue
		}
		r.staleIDs[tableID] = mapping.identity
		delete(r.active, tableID)
		count++
	}
	for key := range r.latestGen {
		identity := identityFromKey(key)
		if !matches(identity) {
			continue
		}
		if current := r.latestGen[key]; current == 0 {
			r.latestGen[key] = 1
		} else {
			r.latestGen[key] = current + 1
		}
		r.invalidated[key] = true
		delete(r.byTable, key)
	}
	r.ddlEpoch++
	return count
}

func identityFromKey(key string) TableIdentity {
	parts := strings.SplitN(key, "\x00", 2)
	if len(parts) != 2 {
		return TableIdentity{Table: key}
	}
	return TableIdentity{Schema: parts[0], Table: parts[1]}
}

// InvalidateAll removes every table-ID mapping.
func (r *SchemaRegistry) InvalidateAll() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ensureInit()
	for tableID, mapping := range r.active {
		r.staleIDs[tableID] = mapping.identity
	}
	for key := range r.latestGen {
		if r.latestGen[key] == 0 {
			r.latestGen[key] = 1
		} else {
			r.latestGen[key]++
		}
		r.invalidated[key] = true
	}
	r.active = make(map[uint64]*activeMapping)
	r.byTable = make(map[string]*activeMapping)
	r.ddlEpoch++
}

// ActiveTableIDs returns a snapshot of currently resolvable table IDs.
func (r *SchemaRegistry) ActiveTableIDs() []uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]uint64, 0, len(r.active))
	for id := range r.active {
		out = append(out, id)
	}
	return out
}

func normalizeTableMap(tm TableMap) (TableMap, string, TableIdentity, error) {
	if strings.TrimSpace(tm.Table) == "" {
		return TableMap{}, "", TableIdentity{}, fmt.Errorf("%w: empty table name", errInvalidTableMap)
	}
	out := tm.clone()
	if out.TableID == 0 {
		out.TableID = out.TableId
	}
	if out.Schema == "" {
		out.Schema = out.Database
	}
	if len(out.Columns) == 0 && len(out.ColumnNames) > 0 {
		out.Columns = make([]Column, len(out.ColumnNames))
		for i, name := range out.ColumnNames {
			out.Columns[i].Name = name
			if i < len(out.ColumnTypes) {
				out.Columns[i].Type = out.ColumnTypes[i]
			}
			if i < len(out.UnsignedMap) {
				out.Columns[i].Unsigned = out.UnsignedMap[i]
			}
		}
	}
	out.Schema = strings.TrimSpace(out.Schema)
	out.Table = strings.TrimSpace(out.Table)

	seen := make(map[string]struct{}, len(out.Columns))
	for i := range out.Columns {
		column := &out.Columns[i]
		column.Name = strings.TrimSpace(column.Name)
		if column.Name == "" {
			return TableMap{}, "", TableIdentity{}, fmt.Errorf("%w: column %d has no name", errInvalidTableMap, i)
		}
		lower := strings.ToLower(column.Name)
		if _, ok := seen[lower]; ok {
			return TableMap{}, "", TableIdentity{}, fmt.Errorf("%w: duplicate column %q", errInvalidTableMap, column.Name)
		}
		seen[lower] = struct{}{}
		if column.Type == TypeUnknown && column.MySQLType != 0 {
			column.Type = MySQLColumnType(column.MySQLType)
		}
		typeName, typeUnsigned := ParseColumnType(column.Type)
		column.Type = typeName
		column.Unsigned = column.Unsigned || typeUnsigned || tmUnsignedAt(tm, i)
	}
	if len(out.Columns) > 0 {
		out.ColumnNames = make([]string, len(out.Columns))
		out.ColumnTypes = make([]ColumnType, len(out.Columns))
		out.UnsignedMap = make([]bool, len(out.Columns))
		for i, column := range out.Columns {
			out.ColumnNames[i] = column.Name
			out.ColumnTypes[i] = column.Type
			out.UnsignedMap[i] = column.Unsigned
		}
	}

	keys := out.SortKeyColumns()
	for _, key := range keys {
		if _, ok := out.Column(key); !ok {
			return TableMap{}, "", TableIdentity{}, fmt.Errorf("%w: key column %q is not present", errInvalidTableMap, key)
		}
	}

	identity := out.Identity()
	return out, tableMapFingerprint(out), identity, nil
}

func tmUnsignedAt(tm TableMap, index int) bool {
	return index < len(tm.UnsignedMap) && tm.UnsignedMap[index]
}

func tableMapFingerprint(tm TableMap) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%s\x00", tm.Schema, tm.Table)
	for _, column := range tm.Columns {
		fmt.Fprintf(h, "%s\x00%s\x00%t\x00%t\x00%t\x00%d\x00%d\x00",
			strings.ToLower(column.Name),
			column.CanonicalType(),
			column.Unsigned,
			column.Nullable,
			column.PrimaryKey,
			column.Precision,
			column.Scale,
		)
	}
	for _, key := range tm.SortKeyColumns() {
		fmt.Fprintf(h, "key:%s\x00", strings.ToLower(key))
	}
	return hex.EncodeToString(h.Sum(nil))
}

var (
	backtickIdent = "`(?:[^`]|``)+`|[A-Za-z0-9_$]+"
	tableRef      = fmt.Sprintf("(%s)(?:\\s*\\.\\s*(%s))?", backtickIdent, backtickIdent)
)

var (
	alterTableRe    = regexp.MustCompile(`(?is)^\s*ALTER\s+TABLE\s+` + tableRef)
	dropTableRe     = regexp.MustCompile(`(?is)^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?` + tableRef)
	truncateTableRe = regexp.MustCompile(`(?is)^\s*TRUNCATE\s+(?:TABLE\s+)?` + tableRef)
	createTableRe   = regexp.MustCompile(`(?is)^\s*CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` + tableRef)
	renameTableRe   = regexp.MustCompile(`(?is)^\s*RENAME\s+TABLE\s+` + tableRef + `\s+TO\s+` + tableRef)
)

// ParseDDL extracts the common table-level DDL forms. Unknown statements are
// still returned as DDLUnknown with an empty Affected list; callers should
// populate Affected explicitly for those.
func ParseDDL(query string) DDLEvent {
	event := DDLEvent{Kind: DDLUnknown, Query: query}
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return event
	}

	if matches := renameTableRe.FindStringSubmatch(trimmed); matches != nil {
		oldSchema, oldTable := ddlIdentPair(matches[1], matches[2])
		newSchema, newTable := ddlIdentPair(matches[3], matches[4])
		event.Kind = DDLRename
		event.OldSchema, event.OldTable = oldSchema, oldTable
		event.NewSchema, event.NewTable = newSchema, newTable
		event.Schema, event.Table = oldSchema, oldTable
		return event
	}
	if matches := alterTableRe.FindStringSubmatch(trimmed); matches != nil {
		event.Schema, event.Table = ddlIdentPair(matches[1], matches[2])
		event.Kind = DDLAlter
		return event
	}
	if matches := dropTableRe.FindStringSubmatch(trimmed); matches != nil {
		event.Schema, event.Table = ddlIdentPair(matches[1], matches[2])
		event.Kind = DDLDrop
		return event
	}
	if matches := truncateTableRe.FindStringSubmatch(trimmed); matches != nil {
		event.Schema, event.Table = ddlIdentPair(matches[1], matches[2])
		event.Kind = DDLTruncate
		return event
	}
	if matches := createTableRe.FindStringSubmatch(trimmed); matches != nil {
		event.Schema, event.Table = ddlIdentPair(matches[1], matches[2])
		event.Kind = DDLCreate
		return event
	}
	return event
}

func ddlIdentPair(first, second string) (string, string) {
	if second == "" {
		return "", unquoteIdent(first)
	}
	return unquoteIdent(first), unquoteIdent(second)
}

func unquoteIdent(ident string) string {
	ident = strings.TrimSpace(ident)
	if len(ident) >= 2 && ident[0] == '`' && ident[len(ident)-1] == '`' {
		return strings.ReplaceAll(ident[1:len(ident)-1], "``", "`")
	}
	return ident
}

// DDLGeneration is a small helper used by tests and adapters that need to know
// whether a DDL changes the current generation counters without registering a
// map.
func (r *SchemaRegistry) DDLGeneration(schema, table string) uint64 {
	return r.Generation(schema, table)
}

// String implements fmt.Stringer for a generation descriptor. It is mostly
// useful in diagnostics.
func TableGeneration(schema, table string, generation uint64) string {
	if schema == "" {
		return table + "@" + strconv.FormatUint(generation, 10)
	}
	return schema + "." + table + "@" + strconv.FormatUint(generation, 10)
}

// KeyColumns returns the effective primary-key column names for a table map.
func KeyColumns(tm TableMap) []string {
	return tm.ResolvedKeyColumns()
}

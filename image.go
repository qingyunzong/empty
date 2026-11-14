package dataeng

import (
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NormalizeValue applies column metadata to a decoded binlog value.
//
// The main responsibility is unsigned integer handling: MySQL sends the raw
// two's-complement bits and many Go decoders expose them as a signed integer.
// For an unsigned column, negative values are reinterpreted at the column's
// storage width and all integer results are returned as uint64, so a value
// above math.MaxInt64 is never truncated or made negative.
func NormalizeValue(column Column, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	if text := strings.ToLower(string(column.Type)); strings.Contains(text, "unsigned") {
		column.Unsigned = true
	}

	switch typed := value.(type) {
	case sql.NullString:
		if !typed.Valid {
			return nil, nil
		}
		return NormalizeValue(column, typed.String)
	case sql.NullInt64:
		if !typed.Valid {
			return nil, nil
		}
		return NormalizeValue(column, typed.Int64)
	case sql.NullInt32:
		if !typed.Valid {
			return nil, nil
		}
		return NormalizeValue(column, typed.Int32)
	case sql.NullInt16:
		if !typed.Valid {
			return nil, nil
		}
		return NormalizeValue(column, typed.Int16)
	case sql.NullByte:
		if !typed.Valid {
			return nil, nil
		}
		return NormalizeValue(column, typed.Byte)
	case sql.NullFloat64:
		if !typed.Valid {
			return nil, nil
		}
		return typed.Float64, nil
	case sql.NullBool:
		if !typed.Valid {
			return nil, nil
		}
		return typed.Bool, nil
	case driver.Valuer:
		raw, err := typed.Value()
		if err != nil {
			return nil, err
		}
		return NormalizeValue(column, raw)
	}

	if !column.IsInteger() {
		return value, nil
	}

	if !column.Unsigned {
		return normalizeSignedInteger(value)
	}
	return normalizeUnsignedInteger(column, value)
}

func normalizeSignedInteger(value any) (any, error) {
	switch typed := value.(type) {
	case int:
		return int64(typed), nil
	case int8:
		return int64(typed), nil
	case int16:
		return int64(typed), nil
	case int32:
		return int64(typed), nil
	case int64:
		return typed, nil
	case uint:
		if uint64(typed) > math.MaxInt64 {
			return nil, fmt.Errorf("%w: signed integer overflow: %d", ErrInvalidValue, typed)
		}
		return int64(typed), nil
	case uint8:
		return int64(typed), nil
	case uint16:
		return int64(typed), nil
	case uint32:
		return int64(typed), nil
	case uint64:
		if typed > math.MaxInt64 {
			return nil, fmt.Errorf("%w: signed integer overflow: %d", ErrInvalidValue, typed)
		}
		return int64(typed), nil
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidValue, err)
		}
		return parsed, nil
	case []byte:
		parsed, err := strconv.ParseInt(strings.TrimSpace(string(typed)), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidValue, err)
		}
		return parsed, nil
	case *big.Int:
		if typed == nil || !typed.IsInt64() {
			return nil, fmt.Errorf("%w: signed integer overflow", ErrInvalidValue)
		}
		return typed.Int64(), nil
	case json.Number:
		parsed, err := strconv.ParseInt(string(typed), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidValue, err)
		}
		return parsed, nil
	default:
		return value, nil
	}
}

func normalizeUnsignedInteger(column Column, value any) (any, error) {
	width, _ := column.CanonicalType().IntegerWidth()
	mask := uint64(math.MaxUint64)
	if width > 0 && width < 64 {
		mask = (uint64(1) << uint(width)) - 1
	}

	var raw uint64
	switch typed := value.(type) {
	case uint:
		raw = uint64(typed)
	case uint8:
		raw = uint64(typed)
	case uint16:
		raw = uint64(typed)
	case uint32:
		raw = uint64(typed)
	case uint64:
		raw = typed
	case int:
		raw = uint64(typed)
	case int8:
		raw = uint64(int64(typed))
	case int16:
		raw = uint64(int64(typed))
	case int32:
		raw = uint64(int64(typed))
	case int64:
		raw = uint64(typed)
	case json.Number:
		parsed, err := strconv.ParseUint(string(typed), 10, 64)
		if err != nil {
			// A decoder may still expose the high half as a negative signed
			// number. Fall back to the signed interpretation before masking.
			signed, signedErr := strconv.ParseInt(string(typed), 10, 64)
			if signedErr != nil {
				return nil, fmt.Errorf("%w: %v", ErrInvalidValue, err)
			}
			raw = uint64(signed)
		} else {
			raw = parsed
		}
	case string:
		parsed, err := strconv.ParseUint(strings.TrimSpace(typed), 10, 64)
		if err != nil {
			signed, signedErr := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
			if signedErr != nil {
				return nil, fmt.Errorf("%w: %v", ErrInvalidValue, err)
			}
			raw = uint64(signed)
		} else {
			raw = parsed
		}
	case []byte:
		text := strings.TrimSpace(string(typed))
		if parsed, err := strconv.ParseUint(text, 10, 64); err == nil {
			raw = parsed
			break
		}
		if signed, err := strconv.ParseInt(text, 10, 64); err == nil {
			raw = uint64(signed)
			break
		}
		// Some adapters hand over the raw big-endian binlog bytes.
		if len(typed) > 0 && len(typed) <= 8 {
			raw = 0
			for _, b := range typed {
				raw = (raw << 8) | uint64(b)
			}
			break
		}
		return nil, fmt.Errorf("%w: cannot decode unsigned integer from %d bytes", ErrInvalidValue, len(typed))
	case *big.Int:
		if typed == nil {
			return nil, nil
		}
		if typed.Sign() < 0 {
			raw = uint64(typed.Int64())
		} else if typed.IsUint64() {
			raw = typed.Uint64()
		} else {
			return nil, fmt.Errorf("%w: unsigned integer overflow", ErrInvalidValue)
		}
	default:
		return nil, fmt.Errorf("%w: expected integer for unsigned %s column %q, got %T",
			ErrInvalidValue, column.CanonicalType(), column.Name, value)
	}

	return raw & mask, nil
}

// ErrInvalidValue is returned when a decoded value cannot be represented by
// its column metadata.
var ErrInvalidValue = fmt.Errorf("dataeng: invalid column value")

// MissingColumns returns column names that are absent from an image. A column
// whose value is nil (SQL NULL) is present and is therefore not missing.
func MissingColumns(tm TableMap, image RowImage) []string {
	var missing []string
	for _, column := range tm.Columns {
		if !image.Has(column.Name) {
			missing = append(missing, column.Name)
		}
	}
	// Images may contain columns spelled with different case.
	if len(missing) > 0 && image != nil {
		for i, name := range missing {
			if _, ok := image.Get(name); ok {
				missing[i] = ""
			}
		}
		missing = filterEmpty(missing)
	}
	sort.Strings(missing)
	return missing
}

func filterEmpty(in []string) []string {
	out := in[:0]
	for _, s := range in {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// ReconstructImage overlays images on top of a stored pre-image. It returns
// only known values plus the names of columns whose values are unknown. It
// never synthesises a zero value for an absent column.
func ReconstructImage(tm TableMap, prior *StoredImage, overlays ...RowImage) (RowImage, []string) {
	out := make(RowImage)
	if prior != nil {
		for name, value := range prior.Values {
			out[name] = value
		}
	}
	for _, overlay := range overlays {
		for name, value := range overlay.Canonical(tm) {
			out[name] = value
		}
	}
	return out, MissingColumns(tm, out)
}

// StoredImage is a versioned pre-image kept for MINIMAL row completion.
type StoredImage struct {
	Schema     string
	Table      string
	Generation uint64
	Key        string
	Values     RowImage
	Missing    []string
	Complete   bool
	Version    uint64
	UpdatedAt  time.Time
}

// ImageStore keeps the latest reconstructed image for each logical table,
// generation and primary key. Generations are independent: a row from a new
// TABLE_MAP generation can never be completed from a previous generation.
type ImageStore struct {
	mu sync.RWMutex

	entries map[string]StoredImage
	nextVer map[string]uint64
}

// VersionedImageStore is an alias for ImageStore.
type VersionedImageStore = ImageStore

// NewImageStore creates an empty store.
func NewImageStore() *ImageStore {
	return &ImageStore{
		entries: make(map[string]StoredImage),
		nextVer: make(map[string]uint64),
	}
}

// NewVersionedImageStore is an alias for NewImageStore.
func NewVersionedImageStore() *ImageStore {
	return NewImageStore()
}

func (s *ImageStore) ensureInit() {
	if s.entries == nil {
		s.entries = make(map[string]StoredImage)
	}
	if s.nextVer == nil {
		s.nextVer = make(map[string]uint64)
	}
}

func (s *ImageStore) tableKey(schema, table string, generation uint64) string {
	return schema + "\x00" + table + "\x00" + strconv.FormatUint(generation, 10)
}

func (s *ImageStore) entryKey(schema, table string, generation uint64, key string) string {
	return s.tableKey(schema, table, generation) + "\x00" + key
}

// Get returns the latest stored image.
func (s *ImageStore) Get(schema, table string, generation uint64, key string) (StoredImage, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry, ok := s.entries[s.entryKey(schema, table, generation, key)]
	if !ok {
		return StoredImage{}, false
	}
	entry.Values = entry.Values.Clone()
	entry.Missing = append([]string(nil), entry.Missing...)
	return entry, true
}

// Put stores a new image version and returns the stored entry.
func (s *ImageStore) Put(schema, table string, generation uint64, key string, values RowImage, missing []string, complete bool) StoredImage {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureInit()

	tableKey := s.tableKey(schema, table, generation)
	s.nextVer[tableKey]++
	version := s.nextVer[tableKey]
	entry := StoredImage{
		Schema:     schema,
		Table:      table,
		Generation: generation,
		Key:        key,
		Values:     values.Clone(),
		Missing:    append([]string(nil), missing...),
		Complete:   complete,
		Version:    version,
		UpdatedAt:  time.Now().UTC(),
	}
	s.entries[s.entryKey(schema, table, generation, key)] = entry
	entry.Values = entry.Values.Clone()
	return entry
}

// Delete removes one stored image.
func (s *ImageStore) Delete(schema, table string, generation uint64, key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	entryKey := s.entryKey(schema, table, generation, key)
	if _, ok := s.entries[entryKey]; !ok {
		return false
	}
	delete(s.entries, entryKey)
	return true
}

// ClearGeneration removes all images for one table generation.
func (s *ImageStore) ClearGeneration(schema, table string, generation uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prefix := s.tableKey(schema, table, generation) + "\x00"
	for key := range s.entries {
		if strings.HasPrefix(key, prefix) {
			delete(s.entries, key)
		}
	}
	delete(s.nextVer, s.tableKey(schema, table, generation))
}

// ClearTable removes every generation of a logical table. The pipeline calls
// this immediately after DDL, because a pre-image from before DDL must never
// be used to fill columns after DDL.
func (s *ImageStore) ClearTable(schema, table string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := 0
	for key, entry := range s.entries {
		if entry.Table == table && (schema == "" || entry.Schema == schema) {
			delete(s.entries, key)
			removed++
		}
	}
	for key := range s.nextVer {
		parts := strings.SplitN(key, "\x00", 3)
		if len(parts) == 3 && parts[1] == table && (schema == "" || parts[0] == schema) {
			delete(s.nextVer, key)
		}
	}
	return removed
}

// ClearAll removes every stored image, regardless of generation. It is used
// for DDL statements whose target table cannot be determined.
func (s *ImageStore) ClearAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = make(map[string]StoredImage)
	s.nextVer = make(map[string]uint64)
}

// Len returns the number of stored images.
func (s *ImageStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries)
}

// RowKey builds a stable key from the table's primary-key columns.
//
// It returns the key, the named key values and the names of key columns
// missing from the image. Callers must not substitute zero values for missing
// key columns.
func RowKey(tm TableMap, image RowImage) (string, map[string]any, []string) {
	keyColumns := tm.SortKeyColumns()
	if len(keyColumns) == 0 {
		// Without a declared key, a complete image is still a usable identity
		// for insert/delete operations. Minimal updates cannot be matched
		// reliably, which the caller reports as a missing pre-image.
		keyColumns = allColumnNames(tm)
	}

	values := make(map[string]any, len(keyColumns))
	var missing []string
	for _, name := range keyColumns {
		value, ok := image.Get(name)
		if !ok {
			missing = append(missing, name)
			continue
		}
		column, hasColumn := tm.Column(name)
		if hasColumn {
			normalized, err := NormalizeValue(column, value)
			if err == nil {
				value = normalized
				name = column.Name
			}
		}
		values[name] = value
	}
	if len(missing) > 0 {
		return "", values, missing
	}

	return encodeRowKey(values), values, nil
}

func allColumnNames(tm TableMap) []string {
	names := make([]string, 0, len(tm.Columns))
	for _, column := range tm.Columns {
		names = append(names, column.Name)
	}
	sort.Strings(names)
	return names
}

func encodeRowKey(values map[string]any) string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, name := range names {
		b.WriteString(strings.ToLower(name))
		b.WriteByte('=')
		b.WriteString(encodeKeyValue(values[name]))
		b.WriteByte('|')
	}
	return b.String()
}

func encodeKeyValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return "n"
	case string:
		return "s" + strconv.Itoa(len(typed)) + ":" + typed
	case []byte:
		return "b" + hex.EncodeToString(typed)
	case bool:
		if typed {
			return "t"
		}
		return "f"
	case int:
		return "d" + strconv.FormatInt(int64(typed), 10)
	case int8:
		return "d" + strconv.FormatInt(int64(typed), 10)
	case int16:
		return "d" + strconv.FormatInt(int64(typed), 10)
	case int32:
		return "d" + strconv.FormatInt(int64(typed), 10)
	case int64:
		return "d" + strconv.FormatInt(typed, 10)
	case uint:
		return "u" + strconv.FormatUint(uint64(typed), 10)
	case uint8:
		return "u" + strconv.FormatUint(uint64(typed), 10)
	case uint16:
		return "u" + strconv.FormatUint(uint64(typed), 10)
	case uint32:
		return "u" + strconv.FormatUint(uint64(typed), 10)
	case uint64:
		return "u" + strconv.FormatUint(typed, 10)
	case float32:
		return "F" + strconv.FormatUint(uint64(math.Float32bits(typed)), 16)
	case float64:
		return "D" + strconv.FormatUint(math.Float64bits(typed), 16)
	case *big.Int:
		if typed == nil {
			return "n"
		}
		return "i" + typed.String()
	case big.Int:
		return "i" + typed.String()
	default:
		data, err := json.Marshal(typed)
		if err == nil {
			return "j" + string(data)
		}
		return fmt.Sprintf("x%#v", typed)
	}
}

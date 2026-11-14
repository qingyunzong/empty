package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Pipeline normalises TABLE_MAP and row events into full row images.
//
// The zero value is usable: the registry and image store are created on first
// use. A Pipeline is safe for concurrent use.
type Pipeline struct {
	mu sync.Mutex

	Registry *SchemaRegistry
	Store    *ImageStore
	Images   *ImageStore // compatibility alias for Store
}

// Normalizer is an alias for Pipeline.
type Normalizer = Pipeline

// Option configures a Pipeline.
type Option func(*Pipeline)

// WithSchemaRegistry supplies a registry (useful when a decoder replays an
// existing stream).
func WithSchemaRegistry(registry *SchemaRegistry) Option {
	return func(p *Pipeline) { p.Registry = registry }
}

// WithImageStore supplies a versioned image store.
func WithImageStore(store *ImageStore) Option {
	return func(p *Pipeline) { p.Store = store; p.Images = store }
}

// NewPipeline creates a pipeline.
func NewPipeline(options ...Option) *Pipeline {
	p := &Pipeline{Registry: NewSchemaRegistry(), Store: NewImageStore()}
	p.Images = p.Store
	for _, option := range options {
		if option != nil {
			option(p)
		}
	}
	return p
}

// NewNormalizer creates a pipeline. It is an alias for NewPipeline.
func NewNormalizer(options ...Option) *Pipeline {
	return NewPipeline(options...)
}

// NewProcessor is an alias for NewPipeline.
func NewProcessor(options ...Option) *Pipeline {
	return NewPipeline(options...)
}

// New creates a pipeline.
func New(options ...Option) *Pipeline {
	return NewPipeline(options...)
}

func (p *Pipeline) ensureInit() {
	if p.Registry == nil {
		p.Registry = NewSchemaRegistry()
	}
	if p.Store == nil && p.Images != nil {
		p.Store = p.Images
	}
	if p.Store == nil {
		p.Store = NewImageStore()
	}
	if p.Images == nil {
		p.Images = p.Store
	}
}

// SchemaRegistry returns the pipeline's registry.
func (p *Pipeline) SchemaRegistry() *SchemaRegistry {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureInit()
	return p.Registry
}

// ImageStore returns the pipeline's versioned image store.
func (p *Pipeline) ImageStore() *ImageStore {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureInit()
	return p.Store
}

// ApplyTableMap registers a TABLE_MAP event, assigning its generation.
func (p *Pipeline) ApplyTableMap(tm TableMap) error {
	_, err := p.RegisterTableMap(tm)
	return err
}

// RegisterTableMap registers a TABLE_MAP and returns the map with its assigned
// generation and schema fingerprint.
func (p *Pipeline) RegisterTableMap(tm TableMap) (TableMap, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureInit()
	return p.Registry.Register(tm)
}

// ProcessTableMap is an alias for RegisterTableMap.
func (p *Pipeline) ProcessTableMap(tm TableMap) (TableMap, error) {
	return p.RegisterTableMap(tm)
}

// Register is an alias for RegisterTableMap.
func (p *Pipeline) Register(tm TableMap) (TableMap, error) {
	return p.RegisterTableMap(tm)
}

// HandleTableMap is an alias for RegisterTableMap.
func (p *Pipeline) HandleTableMap(tm TableMap) (TableMap, error) {
	return p.RegisterTableMap(tm)
}

// ApplyDDL invalidates the TABLE_MAP generation of every affected table and
// removes its stored pre-images. A row that arrives after this call but before
// the next TABLE_MAP fails with ErrStaleTableMap.
func (p *Pipeline) ApplyDDL(ddl DDLEvent) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureInit()
	return p.applyDDLLocked(ddl)
}

// ProcessDDL is an alias for ApplyDDL.
func (p *Pipeline) ProcessDDL(ddl DDLEvent) error {
	return p.ApplyDDL(ddl)
}

// ApplyDDLEvent is an alias for ApplyDDL.
func (p *Pipeline) ApplyDDLEvent(ddl DDLEvent) error {
	return p.ApplyDDL(ddl)
}

func (p *Pipeline) applyDDLLocked(ddl DDLEvent) error {
	if ddl.Kind == "" {
		if ddl.Type != "" {
			ddl.Kind = ddl.Type
		} else {
			ddl.Kind = ddl.Operation
		}
	}
	if ddl.Kind == DDLUnknown && strings.TrimSpace(ddl.Query) != "" && len(ddl.AffectedTables()) == 0 {
		ddl = ParseDDL(ddl.Query)
	}

	identities := ddl.AffectedTables()
	if len(identities) == 0 {
		// A statement that cannot be tied to a table is treated conservatively:
		// every old mapping is now suspect.
		p.Registry.InvalidateAll()
		p.Store.ClearAll()
		return nil
	}

	p.Registry.Invalidate(identities...)
	for _, identity := range identities {
		p.Store.ClearTable(identity.Schema, identity.Table)
	}
	return nil
}

// NormalizeRow processes one row event and returns a complete image where
// possible. Missing columns are reported, not zero-filled, and produce
// Reconstructable=false.
func (p *Pipeline) NormalizeRow(event RowEvent) (NormalizedRow, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureInit()
	return p.normalizeRowLocked(event)
}

// ProcessRow is an alias for NormalizeRow.
func (p *Pipeline) ProcessRow(event RowEvent) (NormalizedRow, error) {
	return p.NormalizeRow(event)
}

// ApplyRow is an alias for NormalizeRow.
func (p *Pipeline) ApplyRow(event RowEvent) (NormalizedRow, error) {
	return p.NormalizeRow(event)
}

// HandleRow is an alias for NormalizeRow.
func (p *Pipeline) HandleRow(event RowEvent) (NormalizedRow, error) {
	return p.NormalizeRow(event)
}

// Normalize is an alias for NormalizeRow.
func (p *Pipeline) Normalize(event RowEvent) (NormalizedRow, error) {
	return p.NormalizeRow(event)
}

func (p *Pipeline) normalizeRowLocked(event RowEvent) (NormalizedRow, error) {
	if event.TableID == 0 {
		event.TableID = event.TableId
	}
	if event.Before == nil {
		event.Before = event.BeforeImage
	}
	if event.After == nil {
		event.After = event.AfterImage
	}
	eventType := canonicalRowEventType(event.Type)
	if eventType == "" {
		eventType = canonicalRowEventType(event.EventType)
	}
	if eventType == "" {
		eventType = canonicalRowEventType(event.Operation)
	}
	if eventType == "" {
		switch {
		case len(event.Before) > 0 && len(event.After) > 0:
			eventType = RowUpdate
		case len(event.After) > 0:
			eventType = RowInsert
		case len(event.Before) > 0:
			eventType = RowDelete
		}
	}
	switch eventType {
	case RowInsert, RowUpdate, RowDelete:
	default:
		return NormalizedRow{}, fmt.Errorf("%w: %q", ErrInvalidRowEvent, event.Type)
	}

	tableMap, err := p.resolveEventTableMap(event)
	if err != nil {
		return NormalizedRow{}, err
	}
	if event.Schema != "" && !strings.EqualFold(event.Schema, tableMap.Schema) {
		return NormalizedRow{}, fmt.Errorf("%w: event schema %q, table map schema %q",
			ErrTableMapMismatch, event.Schema, tableMap.Schema)
	}
	if event.Table != "" && !strings.EqualFold(event.Table, tableMap.Table) {
		return NormalizedRow{}, fmt.Errorf("%w: event table %q, table map table %q",
			ErrTableMapMismatch, event.Table, tableMap.Table)
	}

	rawBefore := event.Before.Canonical(tableMap)
	rawAfter := event.After.Canonical(tableMap)

	keys := resolveRowKeys(tableMap, event, rawBefore, rawAfter)
	var prior StoredImage
	var hasPrior bool
	if keys.oldKey != "" {
		prior, hasPrior = p.Store.Get(tableMap.Schema, tableMap.Table, tableMap.Generation, keys.oldKey)
	}
	if !hasPrior && eventType == RowInsert && keys.newKey != "" {
		// An INSERT after a partial/duplicate insert can still build on the
		// previous image of the same key.
		prior, hasPrior = p.Store.Get(tableMap.Schema, tableMap.Table, tableMap.Generation, keys.newKey)
	}

	var priorValues RowImage
	if hasPrior {
		priorValues = prior.Values.Clone()
	}

	var warnings []string
	before, err := p.normalizeImage(tableMap, rawBefore, event.BeforeJSONDiffs, priorValues, event.PartialJSON, &warnings)
	if err != nil {
		return NormalizedRow{}, err
	}
	afterBase := mergeImages(tableMap, priorValues, before)
	after, err := p.normalizeImage(tableMap, rawAfter, event.AfterJSONDiffs, afterBase, event.PartialJSON, &warnings)
	if err != nil {
		return NormalizedRow{}, err
	}

	beforeFull, missingBefore := ReconstructImage(tableMap, storedPtr(prior, hasPrior), before)

	var finalImage RowImage
	var missingFinal []string
	switch eventType {
	case RowInsert:
		finalImage, missingFinal = ReconstructImage(tableMap, nil, after)
	case RowUpdate:
		finalImage, missingFinal = ReconstructImage(tableMap, storedPtr(prior, hasPrior), before, after)
	case RowDelete:
		finalImage = beforeFull.Clone()
		missingFinal = append([]string(nil), missingBefore...)
	}

	reconstructable := len(missingFinal) == 0
	beforeReconstructable := len(missingBefore) == 0
	afterReconstructable := reconstructable
	if eventType == RowDelete {
		_, afterMissing := ReconstructImage(tableMap, nil, after)
		afterReconstructable = len(afterMissing) == 0
	}

	if !reconstructable {
		warnings = append(warnings, fmt.Sprintf("columns not reconstructable: %s", strings.Join(missingFinal, ", ")))
	}
	if (eventType == RowUpdate || eventType == RowDelete) && !hasPrior && len(keys.oldMissing) > 0 {
		warnings = append(warnings, "primary-key columns absent from image: "+strings.Join(keys.oldMissing, ", "))
	}
	if (eventType == RowUpdate || eventType == RowDelete) && !hasPrior {
		warnings = append(warnings, "versioned pre-image not found")
	}

	row := NormalizedRow{
		Type:                  eventType,
		Schema:                tableMap.Schema,
		Table:                 tableMap.Table,
		TableID:               tableMap.TableID,
		Generation:            tableMap.Generation,
		PrimaryKey:            resultPrimaryKey(tableMap, eventType, keys),
		Before:                beforeFull,
		After:                 finalImage,
		Row:                   finalImage,
		MissingColumns:        append([]string(nil), missingFinal...),
		MissingBefore:         append([]string(nil), missingBefore...),
		MissingAfter:          append([]string(nil), missingFinal...),
		Reconstructable:       reconstructable,
		BeforeReconstructable: beforeReconstructable,
		AfterReconstructable:  afterReconstructable,
		BaseVersion:           prior.Version,
		Warnings:              dedupeStrings(warnings),
	}
	row.setCompleteness()

	if err := p.storeResult(tableMap, eventType, keys, finalImage, missingFinal, hasPrior, &row); err != nil {
		return NormalizedRow{}, err
	}
	return row, nil
}

func (p *Pipeline) resolveEventTableMap(event RowEvent) (TableMap, error) {
	if event.TableID != 0 || event.Table == "" {
		tableMap, err := p.Registry.Resolve(event.TableID)
		if err == nil || event.Table == "" {
			return tableMap, err
		}
	}
	if event.Table != "" {
		return p.Registry.ResolveTable(event.Schema, event.Table)
	}
	return TableMap{}, fmt.Errorf("%w: row event has neither table id nor table name", ErrUnknownTableMap)
}

var ErrInvalidRowEvent = errors.New("dataeng: invalid row event")

type rowKeys struct {
	oldKey     string
	newKey     string
	oldPK      map[string]any
	newPK      map[string]any
	oldMissing []string
	newMissing []string
}

func resolveRowKeys(tm TableMap, event RowEvent, before, after RowImage) rowKeys {
	var out rowKeys
	explicit := event.RowKey
	if len(explicit) > 0 {
		key, pk, missing := RowKey(tm, explicit)
		out.oldKey, out.newKey = key, key
		out.oldPK, out.newPK = pk, pk
		out.oldMissing, out.newMissing = missing, missing
		return out
	}

	sourceOld := before
	if len(sourceOld) == 0 {
		sourceOld = after
	}
	out.oldKey, out.oldPK, out.oldMissing = RowKey(tm, sourceOld)

	sourceNew := after
	if len(sourceNew) == 0 {
		sourceNew = before
	}
	out.newKey, out.newPK, out.newMissing = RowKey(tm, sourceNew)
	return out
}

func resultPrimaryKey(tm TableMap, eventType RowEventType, keys rowKeys) map[string]any {
	if len(tm.SortKeyColumns()) == 0 {
		return nil
	}
	var source map[string]any
	if eventType == RowDelete {
		source = keys.oldPK
	} else {
		source = keys.newPK
	}
	if len(source) == 0 {
		return nil
	}
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func storedPtr(stored StoredImage, ok bool) *StoredImage {
	if !ok {
		return nil
	}
	return &stored
}

func mergeImages(tm TableMap, images ...RowImage) RowImage {
	out := make(RowImage)
	for _, image := range images {
		for name, value := range image.Canonical(tm) {
			out[name] = value
		}
	}
	return out
}

func (p *Pipeline) storeResult(tm TableMap, eventType RowEventType, keys rowKeys, image RowImage, missing []string, hadPrior bool, row *NormalizedRow) error {
	switch eventType {
	case RowInsert:
		if keys.newKey == "" {
			return nil
		}
		entry := p.Store.Put(tm.Schema, tm.Table, tm.Generation, keys.newKey, image, missing, len(missing) == 0)
		row.Version = entry.Version
	case RowUpdate:
		if keys.newKey == "" {
			return nil
		}
		if keys.oldKey != "" && keys.oldKey != keys.newKey {
			p.Store.Delete(tm.Schema, tm.Table, tm.Generation, keys.oldKey)
		}
		entry := p.Store.Put(tm.Schema, tm.Table, tm.Generation, keys.newKey, image, missing, len(missing) == 0)
		row.Version = entry.Version
	case RowDelete:
		key := keys.oldKey
		if key == "" {
			key = keys.newKey
		}
		if key != "" {
			p.Store.Delete(tm.Schema, tm.Table, tm.Generation, key)
		}
	}
	return nil
}

func (p *Pipeline) normalizeImage(tm TableMap, raw RowImage, explicit map[string]JSONDiff, base RowImage, partialBinary bool, warnings *[]string) (RowImage, error) {
	out := make(RowImage, len(raw))
	for name, value := range raw {
		column, ok := tm.Column(name)
		if !ok {
			out[name] = value
			*warnings = append(*warnings, fmt.Sprintf("column %q is not in table map", name))
			continue
		}
		name = column.Name

		diff, hasDiff := lookupJSONDiff(explicit, name)
		if !hasDiff {
			diff, hasDiff = IsJSONDiff(value)
		}
		if !hasDiff && column.IsJSON() {
			diff, hasDiff = JSONDiffFromAny(value)
		}
		if !hasDiff && (partialBinary || column.PartialJSON) && column.IsJSON() {
			var decodeFailure error
			switch typed := value.(type) {
			case []byte:
				if len(typed) > 0 {
					decoded, err := DecodeMySQLJSONDiff(typed)
					if err == nil {
						diff, hasDiff = decoded, true
					} else if full, fullErr := DecodeMySQLBinaryJSON(typed); fullErr == nil {
						out[name] = full
						continue
					} else {
						decodeFailure = err
					}
				}
			case json.RawMessage:
				if len(typed) > 0 {
					decoded, err := DecodeMySQLJSONDiff(typed)
					if err == nil {
						diff, hasDiff = decoded, true
					} else {
						decodeFailure = err
					}
				}
			}
			if decodeFailure != nil {
				*warnings = append(*warnings, fmt.Sprintf("column %q: %v", name, decodeFailure))
			}
		}
		if hasDiff {
			baseValue, hasBase := base.Get(name)
			if !hasBase && !diff.HasFullValue {
				*warnings = append(*warnings, fmt.Sprintf("column %q: json partial update requires a pre-image", name))
				continue
			}
			if baseValue == nil && !diff.HasFullValue && !jsonDiffReplacesRoot(diff) {
				*warnings = append(*warnings, fmt.Sprintf("column %q: json partial update cannot modify a NULL base", name))
				continue
			}
			updated, err := ApplyJSONDiff(baseValue, diff)
			if err != nil {
				*warnings = append(*warnings, fmt.Sprintf("column %q: %v", name, err))
				continue
			}
			out[name] = updated
			continue
		}

		if column.IsJSON() {
			if decoded, ok := decodeJSONColumn(value); ok {
				out[name] = decoded
				continue
			}
		}

		normalized, err := NormalizeValue(column, value)
		if err != nil {
			return nil, fmt.Errorf("%w: column %q: %v", ErrInvalidValue, name, err)
		}
		out[name] = normalized
	}

	// Diffs can be supplied for a column that the adapter separated from the
	// row image. Apply them against the base image as well.
	for name, diff := range explicit {
		column, ok := tm.Column(name)
		if !ok {
			*warnings = append(*warnings, fmt.Sprintf("json diff column %q is not in table map", name))
			continue
		}
		if _, exists := out[column.Name]; exists {
			continue
		}
		baseValue, hasBase := base.Get(column.Name)
		if !hasBase && !diff.HasFullValue {
			*warnings = append(*warnings, fmt.Sprintf("column %q: json partial update requires a pre-image", column.Name))
			continue
		}
		if baseValue == nil && !diff.HasFullValue && !jsonDiffReplacesRoot(diff) {
			*warnings = append(*warnings, fmt.Sprintf("column %q: json partial update cannot modify a NULL base", column.Name))
			continue
		}
		updated, err := ApplyJSONDiff(baseValue, diff)
		if err != nil {
			*warnings = append(*warnings, fmt.Sprintf("column %q: %v", column.Name, err))
			continue
		}
		out[column.Name] = updated
	}
	return out, nil
}

func lookupJSONDiff(diffs map[string]JSONDiff, name string) (JSONDiff, bool) {
	if len(diffs) == 0 {
		return JSONDiff{}, false
	}
	if diff, ok := diffs[name]; ok {
		return diff, true
	}
	for key, diff := range diffs {
		if strings.EqualFold(key, name) {
			return diff, true
		}
	}
	return JSONDiff{}, false
}

func decodeJSONColumn(value any) (any, bool) {
	switch typed := value.(type) {
	case json.RawMessage:
		var out any
		if err := json.Unmarshal(typed, &out); err == nil {
			return out, true
		}
		if decoded, err := DecodeMySQLBinaryJSON(typed); err == nil {
			return decoded, true
		}
	case []byte:
		var out any
		if err := json.Unmarshal(typed, &out); err == nil {
			return out, true
		}
		if len(typed) > 0 && isMySQLJSONType(typed[0]) {
			if decoded, err := DecodeMySQLBinaryJSON(typed); err == nil {
				return decoded, true
			}
		}
	case string:
		var out any
		if err := json.Unmarshal([]byte(typed), &out); err == nil {
			return out, true
		}
	}
	return nil, false
}

func isMySQLJSONType(value byte) bool {
	switch value {
	case jsonbSmallObject, jsonbLargeObject, jsonbSmallArray, jsonbLargeArray,
		jsonbLiteral, jsonbInt16, jsonbUint16, jsonbInt32, jsonbUint32,
		jsonbInt64, jsonbUint64, jsonbDouble, jsonbString, jsonbOpaque:
		return true
	default:
		return false
	}
}

// ProcessEvent applies one event.
func (p *Pipeline) ProcessEvent(event Event) (NormalizedEvent, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureInit()
	return p.processEventLocked(event)
}

func (p *Pipeline) processEventLocked(event Event) (NormalizedEvent, error) {
	switch typed := event.(type) {
	case TableMap:
		tm, err := p.Registry.Register(typed)
		if err != nil {
			return NormalizedEvent{Kind: "table_map", Err: err}, err
		}
		return NormalizedEvent{Kind: "table_map", TableMap: &tm}, nil
	case *TableMap:
		if typed == nil {
			return NormalizedEvent{Kind: "table_map", Err: errNilEvent}, errNilEvent
		}
		tm, err := p.Registry.Register(*typed)
		if err != nil {
			return NormalizedEvent{Kind: "table_map", Err: err}, err
		}
		return NormalizedEvent{Kind: "table_map", TableMap: &tm}, nil
	case RowEvent:
		row, err := p.normalizeRowLocked(typed)
		if err != nil {
			return NormalizedEvent{Kind: "row", Err: err}, err
		}
		return NormalizedEvent{Kind: "row", Row: &row}, nil
	case *RowEvent:
		if typed == nil {
			return NormalizedEvent{Kind: "row", Err: errNilEvent}, errNilEvent
		}
		row, err := p.normalizeRowLocked(*typed)
		if err != nil {
			return NormalizedEvent{Kind: "row", Err: err}, err
		}
		return NormalizedEvent{Kind: "row", Row: &row}, nil
	case DDLEvent:
		if err := p.applyDDLLocked(typed); err != nil {
			return NormalizedEvent{Kind: "ddl", DDL: &typed, Err: err}, err
		}
		return NormalizedEvent{Kind: "ddl", DDL: &typed}, nil
	case *DDLEvent:
		if typed == nil {
			return NormalizedEvent{Kind: "ddl", Err: errNilEvent}, errNilEvent
		}
		if err := p.applyDDLLocked(*typed); err != nil {
			return NormalizedEvent{Kind: "ddl", DDL: typed, Err: err}, err
		}
		return NormalizedEvent{Kind: "ddl", DDL: typed}, nil
	default:
		err := fmt.Errorf("%w: %T", ErrInvalidEvent, event)
		return NormalizedEvent{Kind: "unknown", Err: err}, err
	}
}

// Process is an alias for ProcessEvent.
func (p *Pipeline) Process(event Event) (NormalizedEvent, error) {
	return p.ProcessEvent(event)
}

var (
	errNilEvent     = errors.New("dataeng: nil event")
	ErrInvalidEvent = errors.New("dataeng: invalid event type")
)

// ProcessEvents applies a heterogeneous event stream in order.
func (p *Pipeline) ProcessEvents(events []Event) (TransactionResult, error) {
	return p.ProcessTransaction(Transaction{Events: events})
}

// ProcessTransaction applies a transaction payload in order. It returns the
// partial result together with the first error; per-event errors are also
// available in result.Errors.
func (p *Pipeline) ProcessTransaction(transaction Transaction) (TransactionResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ensureInit()

	result := TransactionResult{GTID: transaction.GTID}
	var firstError error

	events := make([]Event, 0, len(transaction.Events)+len(transaction.Payload)+len(transaction.TableMaps)+len(transaction.Rows)+len(transaction.DDLs))
	events = append(events, transaction.Events...)
	events = append(events, transaction.Payload...)
	for i := range transaction.TableMaps {
		events = append(events, transaction.TableMaps[i])
	}
	for i := range transaction.Rows {
		events = append(events, transaction.Rows[i])
	}
	for i := range transaction.DDLs {
		events = append(events, transaction.DDLs[i])
	}

	for _, event := range events {
		normalized, err := p.processEventLocked(event)
		result.Events = append(result.Events, normalized)
		if normalized.TableMap != nil {
			result.TableMaps = append(result.TableMaps, *normalized.TableMap)
		}
		if normalized.DDL != nil {
			result.DDLs = append(result.DDLs, *normalized.DDL)
		}
		if normalized.Row != nil {
			result.Rows = append(result.Rows, *normalized.Row)
		}
		if err != nil {
			result.Errors = append(result.Errors, err)
			if firstError == nil {
				firstError = err
			}
		}
	}
	allComplete := len(result.Errors) == 0
	for _, row := range result.Rows {
		if !row.Reconstructable {
			allComplete = false
			break
		}
	}
	result.AllReconstructable = allComplete
	result.AllRowsComplete = allComplete
	return result, firstError
}

// ApplyTransaction is an alias for ProcessTransaction.
func (p *Pipeline) ApplyTransaction(transaction Transaction) (TransactionResult, error) {
	return p.ProcessTransaction(transaction)
}

// HandleTransaction is an alias for ProcessTransaction.
func (p *Pipeline) HandleTransaction(transaction Transaction) (TransactionResult, error) {
	return p.ProcessTransaction(transaction)
}

// NormalizeTransaction is an alias for ProcessTransaction.
func (p *Pipeline) NormalizeTransaction(transaction Transaction) (TransactionResult, error) {
	return p.ProcessTransaction(transaction)
}

// ProcessEventsInOrder is an alias for ProcessEvents.
func (p *Pipeline) ProcessEventsInOrder(events []Event) (TransactionResult, error) {
	return p.ProcessEvents(events)
}

// SortMissing returns a stable copy of a missing-column list.
func SortMissing(columns []string) []string {
	out := append([]string(nil), columns...)
	sort.Strings(out)
	return out
}

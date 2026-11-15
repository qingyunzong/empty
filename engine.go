package dataeng

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Engine is an in-memory materialization target for ordered CDC
// transactions. It is safe for concurrent use.
//
// Apply is atomic per transaction. A failed transaction, including one
// rejected by a unique-key collision, changes neither rows nor schemas.
type Engine struct {
	mu sync.Mutex

	schemas      map[tableGeneration]Schema
	rows         map[tableGeneration]map[string]Image
	transactions map[string]transactionRecord
}

// Merger is a descriptive alias for Engine.
type Merger = Engine

type tableGeneration struct {
	Table      string
	Generation uint64
}

type transactionRecord struct {
	fingerprint string
	result      Result
}

type preparedChange struct {
	change Change
	schema Schema

	before      Image
	after       Image
	beforeCanon []byte
	afterCanon  []byte
	hasBefore   bool
	hasAfter    bool
	beforeKey   Key
	afterKey    Key
	beforeKeyID string
	afterKeyID  string
}

type migrationPair struct {
	deleteChange int
	insertChange int
}

// New creates an empty merge engine.
func New() *Engine { return NewEngine() }

// NewEngine creates an empty merge engine.
func NewEngine() *Engine {
	return &Engine{
		schemas:      make(map[tableGeneration]Schema),
		rows:         make(map[tableGeneration]map[string]Image),
		transactions: make(map[string]transactionRecord),
	}
}

// NewMerger creates an empty merge engine.
func NewMerger() *Engine { return NewEngine() }

func (e *Engine) initLocked() {
	if e.schemas == nil {
		e.schemas = make(map[tableGeneration]Schema)
	}
	if e.rows == nil {
		e.rows = make(map[tableGeneration]map[string]Image)
	}
	if e.transactions == nil {
		e.transactions = make(map[string]transactionRecord)
	}
}

// RegisterSchema records a table schema generation. Registering the same
// schema again is harmless; registering different keys or columns for the same
// table generation is an error.
func (e *Engine) RegisterSchema(schema Schema) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.initLocked()

	normalized, err := normalizeSchema(schema)
	if err != nil {
		return err
	}
	if existing, ok := e.schemas[tableGeneration{Table: normalized.Table, Generation: normalized.Generation}]; ok {
		if !sameSchema(existing, normalized) {
			return fmt.Errorf("%w: table %q generation %d is already registered differently",
				ErrInvalidSchema, normalized.Table, normalized.Generation)
		}
		return nil
	}
	e.schemas[tableGeneration{Table: normalized.Table, Generation: normalized.Generation}] = normalized
	return nil
}

// Schema returns the registered schema for a table generation.
func (e *Engine) Schema(table string, generation uint64) (Schema, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	schema, ok := e.schemas[tableGeneration{Table: table, Generation: generation}]
	if !ok {
		return Schema{}, false
	}
	return cloneSchema(schema), true
}

// Apply applies one transaction atomically.
//
// A transaction ID is a replay identity. If the same transaction is applied
// again with the same content, Apply returns the original result (including
// the original migration IDs) without touching state. Reusing an ID with
// different content returns ErrTransactionConflict.
func (e *Engine) Apply(transaction Transaction) (Result, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.initLocked()

	prepared, fingerprint, err := e.prepare(transaction)
	if err != nil {
		return Result{}, err
	}

	if record, exists := e.transactions[transaction.ID]; exists {
		if record.fingerprint != fingerprint {
			return Result{}, fmt.Errorf("%w: %q", ErrTransactionConflict, transaction.ID)
		}
		return record.result.clone(), nil
	}

	result, err := e.applyPrepared(transaction.ID, prepared)
	if err != nil {
		return Result{}, err
	}

	e.commitPreparedSchemas(prepared)
	e.transactions[transaction.ID] = transactionRecord{
		fingerprint: fingerprint,
		result:      result.clone(),
	}
	return result, nil
}

// ApplyTransaction is an alias for Apply.
func (e *Engine) ApplyTransaction(transaction Transaction) (Result, error) {
	return e.Apply(transaction)
}

// Merge is an alias for Apply.
func (e *Engine) Merge(transaction Transaction) (Result, error) {
	return e.Apply(transaction)
}

// Result returns the cached result for a successfully applied transaction.
func (e *Engine) Result(transactionID string) (Result, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()

	record, ok := e.transactions[transactionID]
	if !ok {
		return Result{}, false
	}
	return record.result.clone(), true
}

// Rows returns deterministic snapshots of all rows for a table generation.
// Ordering is by canonical primary key so repeated reads are stable.
func (e *Engine) Rows(table string, generation uint64) []Image {
	e.mu.Lock()
	defer e.mu.Unlock()

	rows := e.rows[tableGeneration{Table: table, Generation: generation}]
	keys := make([]string, 0, len(rows))
	for key := range rows {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	out := make([]Image, 0, len(keys))
	for _, key := range keys {
		out = append(out, rows[key].Clone())
	}
	return out
}

// Lookup returns the row identified by primary-key values for a table
// generation. The schema must have been registered or used by a previous
// successful transaction.
func (e *Engine) Lookup(table string, generation uint64, primaryKey map[string]Value) (Image, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	schema, ok := e.schemas[tableGeneration{Table: table, Generation: generation}]
	if !ok {
		return nil, false, fmt.Errorf("%w: table %q generation %d", ErrSchemaNotFound, table, generation)
	}
	_, keyID, err := makeKey(schema, primaryKey, "lookup")
	if err != nil {
		return nil, false, err
	}
	row, ok := e.rows[tableGeneration{Table: table, Generation: generation}][keyID]
	if !ok {
		return nil, false, nil
	}
	return row.Clone(), true, nil
}

func (e *Engine) prepare(transaction Transaction) ([]preparedChange, string, error) {
	if strings.TrimSpace(transaction.ID) == "" {
		return nil, "", fmt.Errorf("%w: transaction ID is empty", ErrInvalidTransaction)
	}

	pending := make(map[tableGeneration]Schema)
	prepared := make([]preparedChange, len(transaction.Changes))

	for index, raw := range transaction.Changes {
		change := Change{
			Operation:        raw.Operation,
			Table:            raw.Table,
			SchemaGeneration: raw.SchemaGeneration,
			PrimaryKey:       append([]string(nil), raw.PrimaryKey...),
			Before:           raw.Before.Clone(),
			After:            raw.After.Clone(),
		}

		schema, err := e.resolveSchema(change, pending)
		if err != nil {
			return nil, "", fmt.Errorf("%w: change %d: %w", ErrInvalidTransaction, index, err)
		}

		preparedChange, err := prepareChange(change, schema)
		if err != nil {
			return nil, "", fmt.Errorf("%w: change %d: %w", ErrInvalidTransaction, index, err)
		}
		prepared[index] = preparedChange
	}

	fingerprint, err := transactionFingerprint(transaction.ID, prepared)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %w", ErrInvalidTransaction, err)
	}
	return prepared, fingerprint, nil
}

func (e *Engine) resolveSchema(change Change, pending map[tableGeneration]Schema) (Schema, error) {
	tableKey := tableGeneration{Table: change.Table, Generation: change.SchemaGeneration}
	if strings.TrimSpace(change.Table) == "" {
		return Schema{}, fmt.Errorf("%w: table is empty", ErrInvalidSchema)
	}

	registered, registeredOK := e.schemas[tableKey]
	if !registeredOK {
		registered, registeredOK = pending[tableKey]
	}

	if len(change.PrimaryKey) == 0 {
		if !registeredOK {
			return Schema{}, fmt.Errorf("%w: table %q generation %d",
				ErrSchemaNotFound, change.Table, change.SchemaGeneration)
		}
		return cloneSchema(registered), nil
	}

	inline := Schema{
		Table:      change.Table,
		Generation: change.SchemaGeneration,
		PrimaryKey: append([]string(nil), change.PrimaryKey...),
	}
	if registeredOK {
		inline.Columns = append([]string(nil), registered.Columns...)
	}
	inline, err := normalizeSchema(inline)
	if err != nil {
		return Schema{}, err
	}
	if registeredOK && !stringSlicesEqual(registered.PrimaryKey, inline.PrimaryKey) {
		return Schema{}, fmt.Errorf("%w: table %q generation %d has conflicting primary keys",
			ErrInvalidSchema, change.Table, change.SchemaGeneration)
	}
	if registeredOK && len(registered.Columns) > 0 && !stringSlicesEqual(registered.Columns, inline.Columns) {
		return Schema{}, fmt.Errorf("%w: table %q generation %d has conflicting columns",
			ErrInvalidSchema, change.Table, change.SchemaGeneration)
	}
	pending[tableKey] = inline
	return cloneSchema(inline), nil
}

func (e *Engine) commitPreparedSchemas(prepared []preparedChange) {
	for _, change := range prepared {
		tableKey := tableGeneration{Table: change.schema.Table, Generation: change.schema.Generation}
		if _, exists := e.schemas[tableKey]; exists {
			continue
		}
		e.schemas[tableKey] = cloneSchema(change.schema)
	}
}

func prepareChange(change Change, schema Schema) (preparedChange, error) {
	out := preparedChange{
		change: change,
		schema: schema,
		before: change.Before,
		after:  change.After,
	}

	switch change.Operation {
	case Insert:
		if change.After == nil {
			return preparedChange{}, fmt.Errorf("%w: insert requires an after image", ErrInvalidTransaction)
		}
	case Delete:
		if change.Before == nil {
			return preparedChange{}, fmt.Errorf("%w: delete requires a before image", ErrInvalidTransaction)
		}
	case Update:
		if change.Before == nil || change.After == nil {
			return preparedChange{}, fmt.Errorf("%w: update requires both before and after images", ErrInvalidTransaction)
		}
	default:
		return preparedChange{}, fmt.Errorf("%w: unknown operation %q", ErrInvalidTransaction, change.Operation)
	}

	var err error
	if change.Before != nil {
		out.beforeCanon, err = canonicalImage(change.Before)
		if err != nil {
			return preparedChange{}, fmt.Errorf("%w: before image: %w", ErrInvalidTransaction, err)
		}
		out.hasBefore = true
		out.beforeKey, out.beforeKeyID, err = makeKey(schema, change.Before, "before image")
		if err != nil {
			return preparedChange{}, err
		}
	}
	if change.After != nil {
		out.afterCanon, err = canonicalImage(change.After)
		if err != nil {
			return preparedChange{}, fmt.Errorf("%w: after image: %w", ErrInvalidTransaction, err)
		}
		out.hasAfter = true
		out.afterKey, out.afterKeyID, err = makeKey(schema, change.After, "after image")
		if err != nil {
			return preparedChange{}, err
		}
	}

	if change.Operation == Update && out.beforeKeyID != out.afterKeyID {
		return preparedChange{}, fmt.Errorf("%w: %s -> %s",
			ErrKeyChangeInUpdate, out.beforeKey.String(), out.afterKey.String())
	}
	return out, nil
}

func (e *Engine) applyPrepared(transactionID string, prepared []preparedChange) (Result, error) {
	working := make(map[tableGeneration]map[string]Image, len(e.rows))
	initialKeys := make(map[string]map[string]struct{})
	for tableKey, rows := range e.rows {
		copied := make(map[string]Image, len(rows))
		keys := initialKeys[tableKey.Table]
		if keys == nil {
			keys = make(map[string]struct{})
			initialKeys[tableKey.Table] = keys
		}
		for key, row := range rows {
			copied[key] = row
			keys[key] = struct{}{}
		}
		working[tableKey] = copied
	}

	pairs := planMigrationPairs(prepared)
	processAt := make(map[int]migrationPair, len(pairs))
	consumed := make(map[int]struct{}, 2*len(pairs))
	for _, pair := range pairs {
		start := pair.deleteChange
		if pair.insertChange < start {
			start = pair.insertChange
		}
		processAt[start] = pair
		consumed[pair.deleteChange] = struct{}{}
		consumed[pair.insertChange] = struct{}{}
	}

	result := Result{
		TransactionID: transactionID,
		Migrations:    make([]Migration, 0, len(pairs)),
		ChangeCount:   len(prepared),
	}
	insertedKeys := make(map[string]struct{})

	for index := 0; index < len(prepared); index++ {
		if pair, ok := processAt[index]; ok {
			migration, err := applyMigration(working, initialKeys, insertedKeys, transactionID, prepared, pair)
			if err != nil {
				return Result{}, err
			}
			result.Migrations = append(result.Migrations, migration)
			continue
		}
		if _, ok := consumed[index]; ok {
			continue
		}
		if err := applySingle(working, initialKeys, insertedKeys, prepared[index]); err != nil {
			return Result{}, err
		}
	}

	e.rows = working
	return result, nil
}

func applyMigration(
	working map[tableGeneration]map[string]Image,
	initialKeys map[string]map[string]struct{},
	insertedKeys map[string]struct{},
	transactionID string,
	prepared []preparedChange,
	pair migrationPair,
) (Migration, error) {
	deletion := prepared[pair.deleteChange]
	insertion := prepared[pair.insertChange]
	tableKey := tableGeneration{Table: deletion.schema.Table, Generation: deletion.schema.Generation}

	rows := ensureRows(working, tableKey)
	stored, ok := rows[deletion.beforeKeyID]
	if !ok {
		return Migration{}, &RowNotFoundError{Key: deletion.beforeKey}
	}
	if err := verifyBeforeImage(stored, deletion.before, deletion.beforeKey); err != nil {
		return Migration{}, err
	}

	targetKeyID := insertion.afterKeyID
	if _, exists := initialKeysFor(initialKeys, deletion.schema.Table)[targetKeyID]; exists {
		return Migration{}, &UniqueViolationError{
			Key:   insertion.afterKey,
			Where: "migration target already exists at transaction start",
		}
	}
	if _, exists := insertedKeys[targetKeyID]; exists {
		return Migration{}, &UniqueViolationError{
			Key:   insertion.afterKey,
			Where: "migration target was already inserted by this transaction",
		}
	}

	delete(rows, deletion.beforeKeyID)
	newRow := stored.Clone()
	if newRow == nil {
		newRow = make(Image, len(insertion.after))
	}
	for column, value := range insertion.after {
		newRow[column] = value
	}
	rows[targetKeyID] = newRow
	insertedKeys[targetKeyID] = struct{}{}

	return Migration{
		ID:               migrationID(transactionID, deletion.beforeKey, insertion.afterKey),
		TransactionID:    transactionID,
		Table:            deletion.schema.Table,
		SchemaGeneration: deletion.schema.Generation,
		From:             deletion.beforeKey.clone(),
		To:               insertion.afterKey.clone(),
		DeleteChange:     pair.deleteChange,
		InsertChange:     pair.insertChange,
	}, nil
}

func applySingle(
	working map[tableGeneration]map[string]Image,
	initialKeys map[string]map[string]struct{},
	insertedKeys map[string]struct{},
	change preparedChange,
) error {
	tableKey := tableGeneration{Table: change.schema.Table, Generation: change.schema.Generation}
	rows := ensureRows(working, tableKey)

	switch change.change.Operation {
	case Insert:
		if _, exists := initialKeysFor(initialKeys, change.schema.Table)[change.afterKeyID]; exists {
			return &UniqueViolationError{
				Key:   change.afterKey,
				Where: "insert target already exists at transaction start",
			}
		}
		if _, exists := insertedKeys[change.afterKeyID]; exists {
			return &UniqueViolationError{
				Key:   change.afterKey,
				Where: "insert target was already inserted by this transaction",
			}
		}
		rows[change.afterKeyID] = change.after.Clone()
		insertedKeys[change.afterKeyID] = struct{}{}
		return nil
	case Delete:
		stored, ok := rows[change.beforeKeyID]
		if !ok {
			return &RowNotFoundError{Key: change.beforeKey}
		}
		if err := verifyBeforeImage(stored, change.before, change.beforeKey); err != nil {
			return err
		}
		delete(rows, change.beforeKeyID)
		return nil
	case Update:
		stored, ok := rows[change.beforeKeyID]
		if !ok {
			return &RowNotFoundError{Key: change.beforeKey}
		}
		if err := verifyBeforeImage(stored, change.before, change.beforeKey); err != nil {
			return err
		}
		updated := stored.Clone()
		if updated == nil {
			updated = make(Image, len(change.after))
		}
		for column, value := range change.after {
			updated[column] = value
		}
		rows[change.beforeKeyID] = updated
		return nil
	default:
		return fmt.Errorf("%w: unknown operation %q", ErrInvalidTransaction, change.change.Operation)
	}
}

func planMigrationPairs(prepared []preparedChange) []migrationPair {
	type groupKey struct {
		table      string
		generation uint64
		primaryKey string
	}
	groups := make(map[groupKey][]int)
	for index, change := range prepared {
		if change.change.Operation != Insert && change.change.Operation != Delete {
			continue
		}
		key := groupKey{
			table:      change.schema.Table,
			generation: change.schema.Generation,
			primaryKey: strings.Join(change.schema.PrimaryKey, "\x00"),
		}
		groups[key] = append(groups[key], index)
	}

	var pairs []migrationPair
	for _, indexes := range groups {
		pairs = append(pairs, pairGroup(prepared, indexes)...)
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].deleteChange != pairs[j].deleteChange {
			return pairs[i].deleteChange < pairs[j].deleteChange
		}
		return pairs[i].insertChange < pairs[j].insertChange
	})
	return pairs
}

func pairGroup(prepared []preparedChange, indexes []int) []migrationPair {
	var deletes, inserts []int
	for _, index := range indexes {
		switch prepared[index].change.Operation {
		case Delete:
			deletes = append(deletes, index)
		case Insert:
			inserts = append(inserts, index)
		}
	}
	if len(deletes) == 0 || len(inserts) == 0 {
		return nil
	}

	parent := make(map[int]int, len(deletes)+len(inserts))
	var find func(int) int
	find = func(node int) int {
		if parent[node] != node {
			parent[node] = find(parent[node])
		}
		return parent[node]
	}
	union := func(left, right int) {
		leftRoot, rightRoot := find(left), find(right)
		if leftRoot != rightRoot {
			parent[rightRoot] = leftRoot
		}
	}
	for _, index := range append(append([]int(nil), deletes...), inserts...) {
		parent[index] = index
	}

	edgeCount := make(map[int]int)
	for _, deleteIndex := range deletes {
		for _, insertIndex := range inserts {
			if prepared[deleteIndex].beforeKeyID == prepared[insertIndex].afterKeyID {
				continue
			}
			if !imagesProvideKeyMigrationEvidence(
				prepared[deleteIndex].schema,
				prepared[deleteIndex].before,
				prepared[insertIndex].after,
			) {
				continue
			}
			union(deleteIndex, insertIndex)
			edgeCount[deleteIndex]++
		}
	}

	type component struct {
		deletes int
		inserts int
		edges   int
		delete  int
		insert  int
	}
	components := make(map[int]*component)
	add := func(index int, operation Operation) {
		root := find(index)
		item := components[root]
		if item == nil {
			item = &component{}
			components[root] = item
		}
		if operation == Delete {
			item.deletes++
			item.delete = index
		} else {
			item.inserts++
			item.insert = index
		}
	}
	for _, index := range deletes {
		add(index, Delete)
	}
	for _, index := range inserts {
		add(index, Insert)
	}
	for _, deleteIndex := range deletes {
		root := find(deleteIndex)
		if item := components[root]; item != nil {
			item.edges += edgeCount[deleteIndex]
		}
	}

	var pairs []migrationPair
	for _, item := range components {
		// Only an isolated one-to-one edge is proof. A component with extra
		// candidates is ambiguous, so the engine leaves those changes alone
		// rather than guessing which rows were paired.
		if item.deletes == 1 && item.inserts == 1 && item.edges == 1 {
			pairs = append(pairs, migrationPair{
				deleteChange: item.delete,
				insertChange: item.insert,
			})
		}
	}
	return pairs
}

func imagesProvideKeyMigrationEvidence(schema Schema, before, after Image) bool {
	if before == nil || after == nil {
		return false
	}

	primaryKey := make(map[string]struct{}, len(schema.PrimaryKey))
	for _, column := range schema.PrimaryKey {
		primaryKey[column] = struct{}{}
	}

	var columns []string
	if len(schema.Columns) > 0 {
		for _, column := range schema.Columns {
			if _, isKey := primaryKey[column]; !isKey {
				columns = append(columns, column)
			}
		}
		sort.Strings(columns)
	} else {
		seen := make(map[string]struct{})
		for _, image := range []Image{before, after} {
			for column := range image {
				if _, isKey := primaryKey[column]; isKey {
					continue
				}
				seen[column] = struct{}{}
			}
		}
		columns = make([]string, 0, len(seen))
		for column := range seen {
			columns = append(columns, column)
		}
		sort.Strings(columns)
	}

	if len(columns) == 0 {
		return false
	}
	for _, column := range columns {
		beforeValue, beforeOK := before[column]
		afterValue, afterOK := after[column]
		if !beforeOK || !afterOK {
			return false
		}
		beforeCanonical, beforeErr := canonicalValue(beforeValue)
		afterCanonical, afterErr := canonicalValue(afterValue)
		if beforeErr != nil || afterErr != nil || string(beforeCanonical) != string(afterCanonical) {
			return false
		}
	}
	return true
}

func makeKey(schema Schema, image Image, role string) (Key, string, error) {
	key := Key{
		Table:            schema.Table,
		SchemaGeneration: schema.Generation,
		Columns:          append([]string(nil), schema.PrimaryKey...),
		Values:           make([]Value, len(schema.PrimaryKey)),
	}
	for index, column := range schema.PrimaryKey {
		value, ok := image[column]
		if !ok {
			return Key{}, "", fmt.Errorf("%w: %s is missing primary-key column %q",
				ErrInvalidTransaction, role, column)
		}
		if value == nil {
			return Key{}, "", fmt.Errorf("%w: %s has NULL primary-key column %q",
				ErrInvalidTransaction, role, column)
		}
		if _, err := canonicalValue(value); err != nil {
			return Key{}, "", fmt.Errorf("%w: %s primary-key column %q: %w",
				ErrInvalidTransaction, role, column, err)
		}
		key.Values[index] = value
	}
	return key, key.rowIdentity(), nil
}

func verifyBeforeImage(stored, before Image, key Key) error {
	for column, expected := range before {
		actual, ok := stored[column]
		if !ok {
			return &BeforeImageMismatchError{Key: key, Column: column}
		}
		actualCanonical, actualErr := canonicalValue(actual)
		expectedCanonical, expectedErr := canonicalValue(expected)
		if actualErr != nil || expectedErr != nil || string(actualCanonical) != string(expectedCanonical) {
			return &BeforeImageMismatchError{Key: key, Column: column}
		}
	}
	return nil
}

func ensureRows(working map[tableGeneration]map[string]Image, tableKey tableGeneration) map[string]Image {
	rows := working[tableKey]
	if rows == nil {
		rows = make(map[string]Image)
		working[tableKey] = rows
	}
	return rows
}

func initialKeysFor(initial map[string]map[string]struct{}, table string) map[string]struct{} {
	keys := initial[table]
	if keys == nil {
		return emptyKeySet
	}
	return keys
}

var emptyKeySet = map[string]struct{}{}

func migrationID(transactionID string, from, to Key) string {
	hash := sha256.New()
	writeFingerprintField(hash, []byte("dataeng.q0237.migration.v1"))
	writeFingerprintField(hash, []byte(transactionID))
	writeFingerprintField(hash, []byte(from.canonical()))
	writeFingerprintField(hash, []byte(to.canonical()))
	return "mig_" + hex.EncodeToString(hash.Sum(nil))
}

func transactionFingerprint(transactionID string, prepared []preparedChange) (string, error) {
	hash := sha256.New()
	writeFingerprintField(hash, []byte("dataeng.q0237.transaction.v1"))
	writeFingerprintField(hash, []byte(transactionID))
	var count [8]byte
	binary.BigEndian.PutUint64(count[:], uint64(len(prepared)))
	writeFingerprintField(hash, count[:])

	for _, change := range prepared {
		writeFingerprintField(hash, []byte(change.change.Operation))
		writeFingerprintField(hash, []byte(change.schema.Table))
		var generation [8]byte
		binary.BigEndian.PutUint64(generation[:], change.schema.Generation)
		writeFingerprintField(hash, generation[:])
		writeFingerprintField(hash, []byte(strings.Join(change.schema.PrimaryKey, "\x00")))
		writeFingerprintField(hash, []byte(strings.Join(change.schema.Columns, "\x00")))
		if change.hasBefore {
			writeFingerprintField(hash, []byte("before"))
			writeFingerprintField(hash, change.beforeCanon)
		} else {
			writeFingerprintField(hash, []byte("no-before"))
		}
		if change.hasAfter {
			writeFingerprintField(hash, []byte("after"))
			writeFingerprintField(hash, change.afterCanon)
		} else {
			writeFingerprintField(hash, []byte("no-after"))
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func writeFingerprintField(hash interface{ Write([]byte) (int, error) }, value []byte) {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	_, _ = hash.Write(length[:])
	_, _ = hash.Write(value)
}

func normalizeSchema(schema Schema) (Schema, error) {
	schema.PrimaryKey = append([]string(nil), schema.PrimaryKey...)
	schema.Columns = append([]string(nil), schema.Columns...)
	if err := schema.Validate(); err != nil {
		return Schema{}, err
	}
	if len(schema.Columns) > 0 {
		seen := make(map[string]struct{}, len(schema.Columns))
		for _, column := range schema.Columns {
			if strings.TrimSpace(column) == "" {
				return Schema{}, fmt.Errorf("%w: table %q generation %d has an empty column",
					ErrInvalidSchema, schema.Table, schema.Generation)
			}
			if _, exists := seen[column]; exists {
				return Schema{}, fmt.Errorf("%w: table %q generation %d repeats column %q",
					ErrInvalidSchema, schema.Table, schema.Generation, column)
			}
			seen[column] = struct{}{}
		}
		for _, column := range schema.PrimaryKey {
			if _, exists := seen[column]; !exists {
				return Schema{}, fmt.Errorf("%w: table %q generation %d column list omits primary-key column %q",
					ErrInvalidSchema, schema.Table, schema.Generation, column)
			}
		}
	}
	return schema, nil
}

func cloneSchema(schema Schema) Schema {
	schema.PrimaryKey = append([]string(nil), schema.PrimaryKey...)
	schema.Columns = append([]string(nil), schema.Columns...)
	return schema
}

func sameSchema(left, right Schema) bool {
	return left.Table == right.Table &&
		left.Generation == right.Generation &&
		stringSlicesEqual(left.PrimaryKey, right.PrimaryKey) &&
		stringSlicesEqual(left.Columns, right.Columns)
}

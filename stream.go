package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
)

// Stream replays one logical stream of schema, dictionary and batch messages.
// The zero value is ready to use; NewStream is the conventional constructor.
type Stream struct {
	schema        *SchemaMessage
	columns       []Column
	columnByID    map[string]Column
	dictionaryIDs map[string]struct{}

	dicts        map[string]*dictionaryState
	pending      []*batchPlan
	batches      int
	readyBatches []Result
	all          []Result
	failures     []*BatchError
	closed       bool
}

// ReplayStream is an alias for Stream.
type ReplayStream = Stream
type Engine = Stream
type Processor = Stream

type dictionaryState struct {
	latest  int
	values  map[int][]any
	records map[int]dictionaryRecord
	pending map[int]dictionaryRecord
}

type dictionaryRecord struct {
	generation int
	mode       DictionaryMode
	values     []any
}

type batchPlan struct {
	sequence    int
	message     *BatchMessage
	columns     []ColumnBatch
	generations map[string]int
}

// NewStream creates an empty replay stream. A schema must be the first message.
func NewStream() *Stream {
	return &Stream{
		columnByID:    make(map[string]Column),
		dictionaryIDs: make(map[string]struct{}),
		dicts:         make(map[string]*dictionaryState),
	}
}

// New is an alias for NewStream.
func New() *Stream { return NewStream() }

// NewReplay is an alias for NewStream.
func NewReplay() *Stream { return NewStream() }

// Apply processes one message and queues any batches that became decodable.
// Results are retrieved with Drain, Next or Results. A *BatchError or
// BatchErrors return value means one or more individual batches failed; the
// stream itself remains usable. Protocol errors do not change stream state.
func (s *Stream) Apply(message any) error {
	results, err := s.apply(message)
	if len(results) > 0 {
		s.readyBatches = append(s.readyBatches, results...)
	}
	return err
}

// Feed is the consuming form of Apply: it processes one message and returns
// only the batches that became decodable because of it.
func (s *Stream) Feed(message any) ([]Result, error) {
	return s.apply(message)
}

// Ingest, Push, Handle and Consume are aliases for Apply.
func (s *Stream) Ingest(message any) error  { return s.Apply(message) }
func (s *Stream) Push(message any) error    { return s.Apply(message) }
func (s *Stream) Handle(message any) error  { return s.Apply(message) }
func (s *Stream) Consume(message any) error { return s.Apply(message) }

func (s *Stream) apply(message any) ([]Result, error) {
	if s.closed {
		return nil, ErrClosed
	}
	normalized, err := normalizeMessage(message)
	if err != nil {
		return nil, err
	}
	mark := len(s.failures)

	var (
		results  []Result
		applyErr error
	)
	switch m := normalized.(type) {
	case SchemaMessage:
		applyErr = s.applySchema(m)
	case DictionaryMessage:
		results, applyErr = s.applyDictionaryMessage(m)
	case BatchMessage:
		results, applyErr = s.applyBatchMessage(m)
	default:
		return nil, fmt.Errorf("%w: unsupported %T", ErrInvalidMessage, normalized)
	}
	if len(results) > 0 {
		s.all = append(s.all, results...)
	}
	if applyErr != nil {
		return results, applyErr
	}
	if newFailures := s.failures[mark:]; len(newFailures) > 0 {
		return results, batchFailureError(newFailures)
	}
	return results, nil
}

// Drain returns and clears batches that are currently ready.
func (s *Stream) Drain() []Result {
	if len(s.readyBatches) == 0 {
		return nil
	}
	results := make([]Result, len(s.readyBatches))
	copy(results, s.readyBatches)
	s.readyBatches = nil
	return results
}

// Next returns the next ready batch.
func (s *Stream) Next() (Result, bool) {
	if len(s.readyBatches) == 0 {
		return Result{}, false
	}
	result := s.readyBatches[0]
	s.readyBatches = s.readyBatches[1:]
	return result, true
}

// Results returns all batches successfully decoded so far, in stream order.
func (s *Stream) Results() []Result {
	results := make([]Result, len(s.all))
	copy(results, s.all)
	return results
}

// Batches is an alias for Results.
func (s *Stream) Batches() []Result { return s.Results() }

// Failures returns all batch-local failures seen so far.
func (s *Stream) Failures() []*BatchError {
	failures := make([]*BatchError, len(s.failures))
	copy(failures, s.failures)
	return failures
}

// Pending reports how many batches are waiting for dictionary generations.
func (s *Stream) Pending() int { return len(s.pending) }

// Closed reports whether Close has been called.
func (s *Stream) Closed() bool { return s.closed }

// Close verifies that no batch or dictionary generation was left dangling.
func (s *Stream) Close() error {
	if s.closed {
		return nil
	}
	s.closed = true
	if s.schema == nil {
		return ErrSchemaRequired
	}

	var problems []error
	for _, plan := range s.pending {
		missing := s.missingFor(plan)
		if len(missing) > 0 {
			problems = append(problems, &PendingBatchError{Sequence: plan.sequence, Missing: missing})
		} else {
			problems = append(problems, &PendingBatchError{Sequence: plan.sequence})
		}
	}
	ids := make([]string, 0, len(s.dicts))
	for id, state := range s.dicts {
		if len(state.pending) > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		state := s.dicts[id]
		problems = append(problems, &MissingGenerationError{DictionaryID: id, Generation: state.latest + 1})
	}
	if len(problems) > 0 {
		return errors.Join(problems...)
	}
	return nil
}

func (s *Stream) applySchema(m SchemaMessage) error {
	if s.schema != nil {
		return ErrSchemaAlreadySet
	}
	columns := append([]Column(nil), m.columns()...)
	if len(columns) == 0 {
		return fmt.Errorf("%w: schema has no columns", ErrInvalidMessage)
	}
	columnByID := make(map[string]Column, len(columns))
	dictionaryIDs := make(map[string]struct{})
	for _, column := range columns {
		name := column.name()
		if name == "" {
			return fmt.Errorf("%w: schema column has no name", ErrInvalidMessage)
		}
		if _, exists := columnByID[name]; exists {
			return fmt.Errorf("%w: schema declares column %q twice", ErrDuplicateColumn, name)
		}
		columnByID[name] = column
		if id := column.dictionaryID(); id != "" {
			dictionaryIDs[id] = struct{}{}
		}
	}
	s.schema = &SchemaMessage{Columns: append([]Column(nil), columns...)}
	s.columns = columns
	s.columnByID = columnByID
	s.dictionaryIDs = dictionaryIDs
	return nil
}

func (s *Stream) applyDictionaryMessage(m DictionaryMessage) ([]Result, error) {
	if s.schema == nil {
		return nil, ErrSchemaRequired
	}
	id := m.dictionaryID()
	if id == "" {
		return nil, fmt.Errorf("%w: dictionary has no ID", ErrInvalidMessage)
	}
	if _, ok := s.dictionaryIDs[id]; !ok {
		return nil, &UnknownDictionaryError{DictionaryID: id}
	}
	generation := m.generation()
	if generation < 1 {
		return nil, ErrInvalidGeneration
	}
	mode, validMode := m.mode()
	if !validMode {
		return nil, fmt.Errorf("%w: %q", ErrInvalidMode, m.Operation)
	}
	values, ok := asValues(m.rawValues())
	if !ok {
		return nil, fmt.Errorf("%w: dictionary values must be a slice, got %T", ErrInvalidMessage, m.rawValues())
	}
	record := dictionaryRecord{generation: generation, mode: mode, values: cloneValues(values)}

	if s.dicts == nil {
		s.dicts = make(map[string]*dictionaryState)
	}
	state := s.dicts[id]
	if state == nil {
		state = &dictionaryState{
			values:  make(map[int][]any),
			records: make(map[int]dictionaryRecord),
			pending: make(map[int]dictionaryRecord),
		}
		s.dicts[id] = state
	}

	if generation <= state.latest {
		existing, exists := state.records[generation]
		if !exists {
			return nil, fmt.Errorf("%w: dictionary %q generation %d predates the first generation", ErrInvalidGeneration, id, generation)
		}
		if !sameDictionaryRecord(existing, record) {
			return nil, &GenerationConflictError{DictionaryID: id, Generation: generation}
		}
		return nil, nil
	}

	if generation > state.latest+1 {
		if existing, exists := state.pending[generation]; exists {
			if !sameDictionaryRecord(existing, record) {
				return nil, &GenerationConflictError{DictionaryID: id, Generation: generation}
			}
			return nil, nil
		}
		state.pending[generation] = record
		return nil, nil
	}

	if err := s.commitDictionary(state, record); err != nil {
		return nil, err
	}
	for {
		next, ok := state.pending[state.latest+1]
		if !ok {
			break
		}
		delete(state.pending, next.generation)
		if err := s.commitDictionary(state, next); err != nil {
			return nil, err
		}
	}
	results, failures := s.releasePending()
	if len(failures) > 0 {
		return results, batchFailureError(failures)
	}
	return results, nil
}

func (s *Stream) commitDictionary(state *dictionaryState, record dictionaryRecord) error {
	generation := record.generation
	if record.mode == DictionaryAppend && generation == 1 {
		return fmt.Errorf("%w: generation 1 must be a replacement, append has no predecessor", ErrInvalidMode)
	}
	payload := cloneValues(record.values)
	var snapshot []any
	if generation > 1 {
		previous, ok := state.values[generation-1]
		if !ok {
			return &MissingGenerationError{Generation: generation - 1}
		}
		switch record.mode {
		case DictionaryAppend:
			// Appending creates a new snapshot and never changes the prefix.
			combined := make([]any, 0, len(previous)+len(payload))
			combined = append(combined, cloneValues(previous)...)
			combined = append(combined, cloneValues(payload)...)
			snapshot = combined
		default:
			// A replacement covers every old item in this generation.
			snapshot = cloneValues(payload)
		}
	} else {
		snapshot = cloneValues(payload)
	}
	if snapshot == nil {
		snapshot = make([]any, 0)
	}
	// Keep the delivered payload for conflict detection; the values map holds
	// the resulting immutable snapshot.
	record.values = payload
	state.values[generation] = snapshot
	state.records[generation] = record
	state.latest = generation
	return nil
}

func sameDictionaryRecord(a, b dictionaryRecord) bool {
	return a.generation == b.generation && a.mode == b.mode && valuesEqual(a.values, b.values)
}

func (s *Stream) applyBatchMessage(m BatchMessage) ([]Result, error) {
	if s.schema == nil {
		return nil, ErrSchemaRequired
	}
	sequence := s.batches
	s.batches++
	plan, err := s.planBatch(sequence, m)
	if err != nil {
		failure := &BatchError{Sequence: sequence, Err: err}
		s.failures = append(s.failures, failure)
		return nil, failure
	}
	s.pending = append(s.pending, plan)
	results, failures := s.releasePending()
	return results, batchFailureError(failures)
}

func (s *Stream) planBatch(sequence int, m BatchMessage) (*batchPlan, error) {
	generations, err := mergeGenerations(
		m.Generations,
		m.RequiredGenerations,
		m.DictionaryGenerations,
		m.DictionaryVersions,
		m.Required,
		m.Dictionaries,
	)
	if err != nil {
		return nil, err
	}
	for id, generation := range generations {
		if _, ok := s.dictionaryIDs[id]; !ok {
			return nil, &UnknownDictionaryError{DictionaryID: id}
		}
		if generation < 1 {
			return nil, fmt.Errorf("%w: dictionary %q requires generation %d", ErrInvalidGeneration, id, generation)
		}
	}
	columns, err := normalizeBatchColumns(&m, s.columns, s.columnByID)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		name := column.name()
		if _, ok := s.columnByID[name]; !ok {
			return nil, &UnknownColumnError{Column: name}
		}
		if _, ok := seen[name]; ok {
			return nil, fmt.Errorf("%w: column %q", ErrDuplicateColumn, name)
		}
		seen[name] = struct{}{}
		declared := s.columnByID[name]
		if id := declared.dictionaryID(); id != "" {
			generation, ok := generations[id]
			if !ok {
				if columnGeneration := column.generation(); columnGeneration > 0 {
					generation = columnGeneration
					generations[id] = generation
					ok = true
				}
			}
			if !ok {
				return nil, fmt.Errorf("%w: column %q uses dictionary %q but no generation was declared", ErrInvalidGeneration, name, id)
			}
			if columnGeneration := column.generation(); columnGeneration > 0 && columnGeneration != generation {
				return nil, fmt.Errorf("%w: column %q declares generation %d but dictionary %q requires %d", ErrInvalidGeneration, name, columnGeneration, id, generation)
			}
			if generation < 1 {
				return nil, fmt.Errorf("%w: dictionary %q requires generation %d", ErrInvalidGeneration, id, generation)
			}
		}
	}
	message := m
	message.Columns = append([]ColumnBatch(nil), columns...)
	message.ColumnBatches = nil
	message.ColumnData = nil
	message.Data = nil
	message.Rows = nil
	message.Indices = nil
	message.Values = nil
	message.Generations = generations
	return &batchPlan{sequence: sequence, message: &message, columns: columns, generations: generations}, nil
}

func (s *Stream) missingFor(plan *batchPlan) []MissingGenerationError {
	var missing []MissingGenerationError
	for id, generation := range plan.generations {
		state := s.dicts[id]
		if state == nil {
			missing = append(missing, MissingGenerationError{DictionaryID: id, Generation: generation})
			continue
		}
		if _, ok := state.values[generation]; !ok {
			missing = append(missing, MissingGenerationError{DictionaryID: id, Generation: generation})
		}
	}
	sort.Slice(missing, func(i, j int) bool {
		if missing[i].DictionaryID == missing[j].DictionaryID {
			return missing[i].Generation < missing[j].Generation
		}
		return missing[i].DictionaryID < missing[j].DictionaryID
	})
	return missing
}

func (s *Stream) batchReady(plan *batchPlan) bool {
	for id, generation := range plan.generations {
		state := s.dicts[id]
		if state == nil {
			return false
		}
		if _, ok := state.values[generation]; !ok {
			return false
		}
	}
	return true
}

// releasePending emits pending batches in arrival order. A blocked batch holds
// back later ones, keeping replay output deterministic.
func (s *Stream) releasePending() ([]Result, []*BatchError) {
	var (
		results  []Result
		failures []*BatchError
	)
	for len(s.pending) > 0 {
		plan := s.pending[0]
		if !s.batchReady(plan) {
			break
		}
		s.pending = s.pending[1:]
		result, err := s.decode(plan)
		if err != nil {
			failure := &BatchError{Sequence: plan.sequence, Err: err}
			s.failures = append(s.failures, failure)
			failures = append(failures, failure)
			continue
		}
		results = append(results, result)
	}
	return results, failures
}

func (s *Stream) decode(plan *batchPlan) (Result, error) {
	result := Result{
		Sequence: plan.sequence,
		Batch:    plan.message,
		Columns:  make([]ResolvedColumn, 0, len(plan.columns)),
	}
	rowCount := -1
	for _, batchColumn := range plan.columns {
		name := batchColumn.name()
		declared := s.columnByID[name]
		dictionaryID := declared.dictionaryID()
		var values []any

		if dictionaryID != "" && batchColumn.rawIndices() != nil {
			indices, ok := asIndices(batchColumn.rawIndices())
			if !ok {
				return Result{}, fmt.Errorf("%w: column %q has non-integer indices", ErrInvalidMessage, name)
			}
			generation, ok := plan.generations[dictionaryID]
			if !ok {
				return Result{}, fmt.Errorf("%w: column %q uses dictionary %q but no generation was declared", ErrInvalidGeneration, name, dictionaryID)
			}
			state := s.dicts[dictionaryID]
			if state == nil {
				return Result{}, &MissingGenerationError{DictionaryID: dictionaryID, Generation: generation}
			}
			if _, ok := state.values[generation]; !ok {
				return Result{}, &MissingGenerationError{DictionaryID: dictionaryID, Generation: generation}
			}
			decoded := state.values[generation]
			values = make([]any, len(indices))
			for i, index := range indices {
				if index == -1 {
					values[i] = nil
					continue
				}
				if index < -1 || index >= len(decoded) {
					return Result{}, &DictionaryIndexError{
						DictionaryID: dictionaryID,
						Generation:   generation,
						Column:       name,
						Index:        index,
						Length:       len(decoded),
					}
				}
				values[i] = cloneValue(decoded[index])
			}
		} else {
			raw := batchColumn.rawValues()
			if raw == nil && dictionaryID == "" {
				// For an ordinary column, a caller may use the compact Indices
				// spelling to carry plain values.
				raw = batchColumn.rawIndices()
			}
			if raw == nil {
				// A column with neither indices nor values is an empty vector.
				values = nil
			} else {
				converted, ok := asValues(raw)
				if !ok {
					return Result{}, fmt.Errorf("%w: column %q values must be a slice", ErrInvalidMessage, name)
				}
				values = cloneValues(converted)
			}
		}

		if rowCount < 0 {
			rowCount = len(values)
		} else if len(values) != rowCount {
			return Result{}, fmt.Errorf("%w: column %q has %d rows, expected %d", ErrColumnLength, name, len(values), rowCount)
		}
		generation := 0
		if dictionaryID != "" {
			generation = plan.generations[dictionaryID]
		}
		result.Columns = append(result.Columns, ResolvedColumn{
			Name:         name,
			Type:         declared.typeName(),
			DictionaryID: dictionaryID,
			Generation:   generation,
			Values:       values,
		})
	}
	if rowCount < 0 {
		rowCount = 0
	}
	result.Rows = make([][]any, rowCount)
	for row := 0; row < rowCount; row++ {
		result.Rows[row] = make([]any, len(result.Columns))
		for column := range result.Columns {
			result.Rows[row][column] = result.Columns[column].Values[row]
		}
	}
	return result, nil
}

func batchFailureError(failures []*BatchError) error {
	if len(failures) == 0 {
		return nil
	}
	if len(failures) == 1 {
		return failures[0]
	}
	return BatchErrors(failures)
}

// BatchErrors groups several batch-local failures.
type BatchErrors []*BatchError

func (e BatchErrors) Error() string {
	switch len(e) {
	case 0:
		return "dataeng: no batch failures"
	case 1:
		return e[0].Error()
	default:
		return fmt.Sprintf("dataeng: %d batches failed (first: %v)", len(e), e[0])
	}
}

func (e BatchErrors) Unwrap() []error {
	errors := make([]error, len(e))
	for i, failure := range e {
		errors[i] = failure
	}
	return errors
}

// Replay processes messages in order and returns all decoded batches. Batch
// local failures are reported in the returned error but do not stop replay;
// protocol failures do.
func Replay(messages ...any) ([]Result, error) {
	stream := NewStream()
	var (
		replayErrors []error
		protocolErr  error
	)
	for _, message := range flattenMessages(messages) {
		results, err := stream.Feed(message)
		_ = results
		if err == nil {
			continue
		}
		if isBatchOnly(err) {
			replayErrors = append(replayErrors, err)
			continue
		}
		protocolErr = err
		break
	}
	if protocolErr != nil {
		_ = stream.Close()
		return stream.Results(), protocolErr
	}
	if err := stream.Close(); err != nil {
		replayErrors = append(replayErrors, err)
	}
	return stream.Results(), errors.Join(replayErrors...)
}

// ReplayMessages is an alias for Replay.
func ReplayMessages(messages ...any) ([]Result, error) { return Replay(messages...) }

// Process is an alias for Replay.
func Process(messages ...any) ([]Result, error) { return Replay(messages...) }

func flattenMessages(messages []any) []any {
	if len(messages) != 1 {
		return messages
	}
	value := messages[0]
	switch value.(type) {
	case []byte, string, SchemaMessage, *SchemaMessage, DictionaryMessage, *DictionaryMessage, BatchMessage, *BatchMessage, map[string]any:
		return messages
	}
	if values, ok := asValues(value); ok {
		return values
	}
	return messages
}

func isBatchOnly(err error) bool {
	if err == nil {
		return false
	}
	var batchErr *BatchError
	if errors.As(err, &batchErr) {
		return true
	}
	var batchErrors BatchErrors
	if errors.As(err, &batchErrors) {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		if len(joined.Unwrap()) == 0 {
			return false
		}
		for _, inner := range joined.Unwrap() {
			if !isBatchOnly(inner) {
				return false
			}
		}
		return true
	}
	return false
}

func valuesEqual(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !equalValue(a[i], b[i]) {
			return false
		}
	}
	return true
}

func equalValue(a, b any) bool {
	return reflect.DeepEqual(a, b)
}

// Schema returns the declared schema, if any.
func (s *Stream) Schema() (SchemaMessage, bool) {
	if s.schema == nil {
		return SchemaMessage{}, false
	}
	return SchemaMessage{Columns: append([]Column(nil), s.schema.Columns...)}, true
}

// Generation returns the newest contiguous generation for a dictionary.
func (s *Stream) Generation(id string) (int, bool) {
	state := s.dicts[id]
	if state == nil || state.latest == 0 {
		return 0, false
	}
	return state.latest, true
}

// DictionarySnapshot returns an immutable copy of a frozen dictionary
// generation. The copy cannot be used to mutate the replay stream.
func (s *Stream) DictionarySnapshot(id string, generation int) ([]any, bool) {
	state := s.dicts[id]
	if state == nil {
		return nil, false
	}
	values, ok := state.values[generation]
	if !ok {
		return nil, false
	}
	return cloneValues(values), true
}

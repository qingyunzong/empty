package dataeng

import (
	"bytes"
	"errors"
	"sort"
)

// Operation is the kind of change carried by a stream record.
type Operation uint8

const (
	Insert Operation = iota + 1
	Update
	Delete
)

func (o Operation) String() string {
	switch o {
	case Insert:
		return "insert"
	case Update:
		return "update"
	case Delete:
		return "delete"
	default:
		return "unknown"
	}
}

// Change is one change-stream record. A record may carry a new tuple, an old
// tuple, and a key tuple at the same time. The key tuple contains only the
// relation's identity columns.
type Change struct {
	Relation  RelationID
	Operation Operation
	New       *Tuple
	Old       *Tuple
	Key       *Tuple
}

// Event is a reassembled change. New and Old contain the columns supplied by
// the stream; Key contains exactly the identity columns. Nil rows were not
// present in the record. External values have been replaced by their chunks.
type Event struct {
	Relation  Relation
	Operation Operation
	New       *Row
	Old       *Row
	Key       *Row
}

// ExternalChunk is one chunk of an external large value. Index is zero-based,
// Total is the number of chunks in the complete value, and Format is ValueText
// or ValueBinary. A zero Format means text on the first chunk and "inherit the
// established format" on later chunks. Chunks may arrive out of order.
type ExternalChunk struct {
	ID     ExternalID
	Index  int
	Total  int
	Format ValueKind
	Data   []byte
}

// Errors returned by the reassembler. Use errors.Is to distinguish them.
var (
	ErrInvalidChange    = errors.New("dataeng: invalid change")
	ErrInvalidChunk     = errors.New("dataeng: invalid external chunk")
	ErrUnknownExternal  = errors.New("dataeng: external identifier is not pending")
	ErrExternalConflict = errors.New("dataeng: conflicting external chunk")
	ErrKeyMismatch      = errors.New("dataeng: key does not match the tuple")
)

type pendingChange struct {
	seq         uint64
	relation    Relation
	operation   Operation
	newRow      *Row
	oldRow      *Row
	keyRow      *Row
	explicitKey bool
	refs        map[ExternalID]struct{}
}

type externalBuffer struct {
	id       ExternalID
	format   ValueKind
	total    int
	chunks   map[int][]byte
	complete bool
	pending  map[*pendingChange]struct{}
}

func newExternalBuffer(id ExternalID) *externalBuffer {
	return &externalBuffer{
		id:      id,
		chunks:  make(map[int][]byte),
		pending: make(map[*pendingChange]struct{}),
	}
}

// Reassembler turns stream records into complete rows. It never contacts a
// database: relation descriptions and external chunks are supplied by the
// caller. The zero value is usable. A Reassembler is not safe for concurrent
// use.
type Reassembler struct {
	relations map[RelationID]Relation
	pending   map[*pendingChange]struct{}
	external  map[ExternalID]*externalBuffer
	nextSeq   uint64
}

// New returns an empty reassembler.
func New() *Reassembler {
	return &Reassembler{
		relations: make(map[RelationID]Relation),
		pending:   make(map[*pendingChange]struct{}),
		external:  make(map[ExternalID]*externalBuffer),
	}
}

// NewReassembler is an alias for New.
func NewReassembler() *Reassembler { return New() }

func (r *Reassembler) ensure() {
	if r.relations == nil {
		r.relations = make(map[RelationID]Relation)
	}
	if r.pending == nil {
		r.pending = make(map[*pendingChange]struct{})
	}
	if r.external == nil {
		r.external = make(map[ExternalID]*externalBuffer)
	}
}

// AddRelation records or replaces a relation description. Tuples already
// pending keep the description that was current when they arrived.
func (r *Reassembler) AddRelation(relation Relation) error {
	if err := relation.validate(); err != nil {
		return err
	}
	r.ensure()
	r.relations[relation.ID] = relation.clone()
	return nil
}

// RemoveRelation forgets a relation description. Pending changes keep their
// snapshot.
func (r *Reassembler) RemoveRelation(id RelationID) {
	delete(r.relations, id)
}

// RelationByID returns a copy of the current description for id.
func (r *Reassembler) RelationByID(id RelationID) (Relation, bool) {
	relation, ok := r.relations[id]
	if !ok {
		return Relation{}, false
	}
	return relation.clone(), true
}

// PendingChanges returns the number of changes waiting for external chunks.
// Such changes are invisible to callers.
func (r *Reassembler) PendingChanges() int { return len(r.pending) }

// PendingChunks returns the number of external values that still have missing
// chunks.
func (r *Reassembler) PendingChunks() int {
	count := 0
	for _, buffer := range r.external {
		if !buffer.complete {
			count++
		}
	}
	return count
}

// Reset discards all relations and pending state.
func (r *Reassembler) Reset() {
	r.relations = make(map[RelationID]Relation)
	r.pending = make(map[*pendingChange]struct{})
	r.external = make(map[ExternalID]*externalBuffer)
	r.nextSeq = 0
}

// EvictExternal discards a completed external value. Pending tuples that
// reference it are unaffected, but later records that reuse the identifier
// will have to wait for its chunks again.
func (r *Reassembler) EvictExternal(id ExternalID) {
	buffer := r.external[id]
	if buffer != nil && buffer.complete && len(buffer.pending) == 0 {
		delete(r.external, id)
	}
}

// IngestChange accepts one change record. It returns the changes that became
// visible as a result. A change that references external values stays
// invisible until all of those values are complete; chunks are delivered with
// IngestChunk.
//
// A tuple for an unknown relation is rejected before any state is changed.
func (r *Reassembler) IngestChange(change Change) ([]Event, error) {
	if err := validateChange(change); err != nil {
		return nil, err
	}

	relation, ok := r.relations[change.Relation]
	if !ok {
		return nil, errorf(ErrRelationNotFound, "relation %d", change.Relation)
	}
	snapshot := relation.clone()

	newRow, err := normalizeTuple(change.New, snapshot, newTuple)
	if err != nil {
		return nil, err
	}
	oldRow, err := normalizeTuple(change.Old, snapshot, oldTuple)
	if err != nil {
		return nil, err
	}
	keyRow, err := normalizeTuple(change.Key, snapshot, keyTuple)
	if err != nil {
		return nil, err
	}
	explicitKey := keyRow != nil

	if keyRow == nil {
		switch change.Operation {
		case Insert:
			keyRow = identityValues(snapshot, newRow, oldRow)
		case Update:
			keyRow = identityValues(snapshot, oldRow, newRow)
		case Delete:
			keyRow = identityValues(snapshot, oldRow)
		}
	}
	if change.Operation == Delete && keyRow == nil && len(snapshot.identityIndexes()) > 0 {
		return nil, errorf(ErrMissingKey, "delete for relation %d has no complete identity tuple", snapshot.ID)
	}

	pending := &pendingChange{
		relation:    snapshot,
		operation:   change.Operation,
		newRow:      newRow,
		oldRow:      oldRow,
		keyRow:      keyRow,
		explicitKey: explicitKey,
		refs:        tupleReferences(newRow, oldRow, keyRow),
	}

	if r.referencesComplete(pending.refs) {
		event, err := r.reassemble(pending)
		if err != nil {
			return nil, err
		}
		return []Event{*event}, nil
	}

	r.ensure()
	r.nextSeq++
	pending.seq = r.nextSeq
	r.pending[pending] = struct{}{}
	for id := range pending.refs {
		buffer := r.external[id]
		if buffer == nil {
			buffer = newExternalBuffer(id)
			r.external[id] = buffer
		}
		buffer.pending[pending] = struct{}{}
	}
	return nil, nil
}

// IngestChunk accepts one chunk of an external value. It returns changes that
// became visible because their last missing chunk arrived. Chunks are accepted
// out of order and repeated identical chunks are ignored.
func (r *Reassembler) IngestChunk(chunk ExternalChunk) ([]Event, error) {
	if err := validateChunk(chunk); err != nil {
		return nil, err
	}
	buffer := r.external[chunk.ID]
	if buffer == nil {
		return nil, errorf(ErrUnknownExternal, "%q", chunk.ID)
	}
	if err := buffer.add(chunk); err != nil {
		return nil, err
	}
	if !buffer.complete {
		return nil, nil
	}

	dependents := make([]*pendingChange, 0, len(buffer.pending))
	for change := range buffer.pending {
		dependents = append(dependents, change)
	}
	sort.Slice(dependents, func(i, j int) bool {
		return dependents[i].seq < dependents[j].seq
	})

	var events []Event
	var errs []error
	for _, change := range dependents {
		if !r.referencesComplete(change.refs) {
			continue
		}
		event, err := r.reassemble(change)
		r.release(change)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		events = append(events, *event)
	}
	return events, errors.Join(errs...)
}

func validateChange(change Change) error {
	switch change.Operation {
	case Insert:
		if change.New == nil {
			return errorf(ErrInvalidChange, "insert has no new tuple")
		}
	case Update:
		if change.New == nil {
			return errorf(ErrInvalidChange, "update has no new tuple")
		}
	case Delete:
		if change.New != nil {
			return errorf(ErrInvalidChange, "delete has a new tuple")
		}
		if change.Old == nil && change.Key == nil {
			return errorf(ErrInvalidChange, "delete has neither an old tuple nor a key tuple")
		}
	default:
		return errorf(ErrInvalidChange, "unknown operation %d", change.Operation)
	}
	return nil
}

func validateChunk(chunk ExternalChunk) error {
	if chunk.ID == "" {
		return errorf(ErrInvalidChunk, "external identifier must not be empty")
	}
	if chunk.Total <= 0 {
		return errorf(ErrInvalidChunk, "total chunk count must be positive")
	}
	if chunk.Index < 0 || chunk.Index >= chunk.Total {
		return errorf(ErrInvalidChunk, "chunk index %d is outside [0,%d)", chunk.Index, chunk.Total)
	}
	format := chunk.Format
	if format == ValueNull {
		format = ValueText
	}
	if format != ValueText && format != ValueBinary {
		return errorf(ErrInvalidChunk, "chunk format %d is not text or binary", chunk.Format)
	}
	return nil
}

func (b *externalBuffer) add(chunk ExternalChunk) error {
	format := chunk.Format
	if b.total == 0 {
		if format == ValueNull {
			format = ValueText
		}
		b.total = chunk.Total
		b.format = format
	} else {
		if chunk.Total != b.total {
			return errorf(ErrExternalConflict, "%q total changed from %d to %d", b.id, b.total, chunk.Total)
		}
		if format != ValueNull && format != b.format {
			return errorf(ErrExternalConflict, "%q format changed", b.id)
		}
	}

	if previous, ok := b.chunks[chunk.Index]; ok {
		if !bytes.Equal(previous, chunk.Data) {
			return errorf(ErrExternalConflict, "%q chunk %d has different data", b.id, chunk.Index)
		}
		return nil
	}
	b.chunks[chunk.Index] = append([]byte(nil), chunk.Data...)
	b.complete = len(b.chunks) == b.total
	return nil
}

func (b *externalBuffer) value() Value {
	size := 0
	for _, chunk := range b.chunks {
		size += len(chunk)
	}
	data := make([]byte, 0, size)
	for index := 0; index < b.total; index++ {
		data = append(data, b.chunks[index]...)
	}
	if b.format == ValueBinary {
		return Value{Kind: ValueBinary, Bytes: data}
	}
	return Value{Kind: ValueText, Text: string(data)}
}

func (r *Reassembler) referencesComplete(refs map[ExternalID]struct{}) bool {
	for id := range refs {
		buffer := r.external[id]
		if buffer == nil || !buffer.complete {
			return false
		}
	}
	return true
}

func (r *Reassembler) reassemble(change *pendingChange) (*Event, error) {
	newRow, err := r.resolveRow(change.newRow, change.relation)
	if err != nil {
		return nil, err
	}
	oldRow, err := r.resolveRow(change.oldRow, change.relation)
	if err != nil {
		return nil, err
	}
	keyRow, err := r.resolveRow(change.keyRow, change.relation)
	if err != nil {
		return nil, err
	}

	if change.explicitKey && keyRow != nil {
		var reference *Row
		switch change.operation {
		case Insert:
			reference = newRow
		case Update, Delete:
			if oldRow != nil {
				reference = oldRow
			}
		}
		if reference != nil {
			for i, column := range keyRow.Columns {
				value, ok := reference.ValueFor(column)
				if ok && !valuesEqual(value, keyRow.Values[i]) {
					return nil, errorf(ErrKeyMismatch, "column %q", change.relation.Columns[column].Name)
				}
			}
		}
	}

	return &Event{
		Relation:  change.relation.clone(),
		Operation: change.operation,
		New:       newRow,
		Old:       oldRow,
		Key:       keyRow,
	}, nil
}

func (r *Reassembler) resolveRow(row *Row, relation Relation) (*Row, error) {
	if row == nil {
		return nil, nil
	}
	resolved := row.clone()
	for i, value := range resolved.Values {
		column := relation.Columns[resolved.Columns[i]]
		if value.Kind == ValueExternal {
			buffer := r.external[value.Ref]
			if buffer == nil || !buffer.complete {
				return nil, errorf(ErrUnknownExternal, "%q", value.Ref)
			}
			value = buffer.value()
		}
		if err := validateValue(value, column); err != nil {
			return nil, err
		}
		resolved.Values[i] = value
	}
	return &resolved, nil
}

func (r *Reassembler) release(change *pendingChange) {
	delete(r.pending, change)
	for id := range change.refs {
		buffer := r.external[id]
		if buffer == nil {
			continue
		}
		delete(buffer.pending, change)
	}
}

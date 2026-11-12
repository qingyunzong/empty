package dataeng

import (
	"errors"
	"fmt"
	"sync"
)

// TypeKind identifies the on-wire type of a column. The only supported
// types are nullable int64, string and bool.
type TypeKind int

const (
	TypeInt64 TypeKind = iota + 1
	TypeString
	TypeBool
)

// Column is a single stable column identifier with its declared type.
type Column struct {
	ID   string
	Type TypeKind
}

// Schema is the ordered column definition of one table generation.
type Schema struct {
	Table      string
	Generation int64
	Columns    []Column
}

// SchemaEvent announces the schema of one table generation. Columns are
// ordered, but rows always address columns through their stable IDs.
type SchemaEvent struct {
	Seq        int64
	Table      string
	Generation int64
	Columns    []Column
}

// RowEvent carries one value sequence for the given table generation.
// The generation may be announced earlier in the same batch or in an
// already committed batch.
type RowEvent struct {
	Seq        int64
	Table      string
	Generation int64
	Values     []any
}

// CommitEvent closes the current batch. Its Seq participates in the
// strictly increasing global sequence.
type CommitEvent struct {
	Seq int64
}

// Record is one decoded row keyed by stable column ID rather than by
// ordinal position, so column reordering between generations cannot
// cross-wire values.
type Record struct {
	Seq        int64
	Table      string
	Generation int64
	Columns    map[string]any
}

// CommittedBatch is the result of a successful commit.
type CommittedBatch struct {
	CommitSeq int64
	// Schemas newly published by this batch, in global sequence order.
	Schemas []Schema
	// Records accepted by this batch, in global sequence order.
	Records []Record
}

// Sentinel errors returned by the decoder. Use errors.Is to match them.
var (
	// ErrSequence means an event carried a sequence number that is not
	// strictly greater than the previous event's.
	ErrSequence = errors.New("global sequence numbers must be strictly increasing")
	// ErrUnknownGeneration means a row references a generation whose
	// schema is neither in the current batch nor already committed.
	ErrUnknownGeneration = errors.New("unknown schema generation")
	// ErrGenerationOrder means schema generations for one table are not
	// strictly increasing, either inside a batch or across commits.
	ErrGenerationOrder = errors.New("schema generations must be strictly increasing")
	// ErrDuplicateSchema means the same table generation is announced
	// more than once in one batch.
	ErrDuplicateSchema = errors.New("duplicate schema generation in batch")
	// ErrInvalidColumn means a schema contains a bad column definition
	// (empty or duplicated ID, unsupported type).
	ErrInvalidColumn = errors.New("invalid column definition")
	// ErrArity means a row value count does not match the schema.
	ErrArity = errors.New("row value count does not match schema column count")
	// ErrTypeMismatch means a row value is neither nil nor the exact
	// Go type declared by the column (int64, string or bool).
	ErrTypeMismatch = errors.New("row value does not match column type")
)

// Decoder consumes schema, row and commit events. Events accepted before
// a commit stay private to the pending batch; a failed commit rolls the
// whole batch back, leaving previously committed state untouched. The
// Decoder is safe for concurrent use.
type Decoder struct {
	mu        sync.Mutex
	lastSeq   int64
	hasSeq    bool
	committed map[string][]Schema
	pending   *batchState
}

type batchState struct {
	schemas     map[string][]Schema
	schemaOrder []Schema
	rows        []RowEvent
}

func newBatch() *batchState {
	return &batchState{schemas: map[string][]Schema{}}
}

// NewDecoder returns an empty decoder.
func NewDecoder() *Decoder {
	return &Decoder{
		committed: map[string][]Schema{},
		pending:   newBatch(),
	}
}

func cloneColumns(in []Column) []Column {
	out := make([]Column, len(in))
	copy(out, in)
	return out
}

func cloneValues(in []any) []any {
	out := make([]any, len(in))
	copy(out, in)
	return out
}

// checkSeq enforces the strictly increasing global sequence. Every
// accepted event, including commits, advances the last seen sequence even
// if the batch is later rejected at commit time.
func (d *Decoder) checkSeq(seq int64) error {
	if d.hasSeq && seq <= d.lastSeq {
		return fmt.Errorf("event seq %d follows %d: %w", seq, d.lastSeq, ErrSequence)
	}
	d.lastSeq = seq
	d.hasSeq = true
	return nil
}

// HandleSchema stages a schema event in the pending batch.
func (d *Decoder) HandleSchema(e SchemaEvent) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.checkSeq(e.Seq); err != nil {
		return err
	}
	s := Schema{
		Table:      e.Table,
		Generation: e.Generation,
		Columns:    cloneColumns(e.Columns),
	}
	d.pending.schemas[e.Table] = append(d.pending.schemas[e.Table], s)
	d.pending.schemaOrder = append(d.pending.schemaOrder, s)
	return nil
}

// HandleRow stages a row event in the pending batch. The generation it
// references does not need to be known yet; resolution happens at commit.
func (d *Decoder) HandleRow(e RowEvent) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.checkSeq(e.Seq); err != nil {
		return err
	}
	d.pending.rows = append(d.pending.rows, RowEvent{
		Seq:        e.Seq,
		Table:      e.Table,
		Generation: e.Generation,
		Values:     cloneValues(e.Values),
	})
	return nil
}

// Schema returns a copy of the committed schema for a table generation.
// Pending (not yet committed) schemas are never exposed.
func (d *Decoder) Schema(table string, generation int64) (Schema, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, s := range d.committed[table] {
		if s.Generation == generation {
			s.Columns = cloneColumns(s.Columns)
			return s, true
		}
	}
	return Schema{}, false
}

// resolve finds a schema in the pending batch first, then among the
// committed generations. Callers must hold d.mu.
func (d *Decoder) resolve(table string, generation int64) (Schema, bool) {
	for _, s := range d.pending.schemas[table] {
		if s.Generation == generation {
			return s, true
		}
	}
	for _, s := range d.committed[table] {
		if s.Generation == generation {
			return s, true
		}
	}
	return Schema{}, false
}

// Commit validates and atomically publishes the pending batch. Any
// validation failure rejects the entire batch: none of its schemas or
// rows become visible and a fresh empty batch is started.
func (d *Decoder) Commit(e CommitEvent) (*CommittedBatch, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := d.checkSeq(e.Seq); err != nil {
		return nil, err
	}
	b := d.pending
	if err := d.validate(b); err != nil {
		d.pending = newBatch()
		return nil, err
	}

	out := &CommittedBatch{CommitSeq: e.Seq}
	for _, s := range b.schemaOrder {
		published := s
		published.Columns = cloneColumns(s.Columns)
		d.committed[s.Table] = append(d.committed[s.Table], published)
		out.Schemas = append(out.Schemas, published)
	}
	for _, r := range b.rows {
		s, _ := d.resolve(r.Table, r.Generation)
		rec := Record{
			Seq:        r.Seq,
			Table:      r.Table,
			Generation: r.Generation,
			Columns:    make(map[string]any, len(s.Columns)),
		}
		for i, col := range s.Columns {
			rec.Columns[col.ID] = r.Values[i]
		}
		out.Records = append(out.Records, rec)
	}
	d.pending = newBatch()
	return out, nil
}

// validate runs every batch-level check. The first failure wins and the
// caller discards the whole batch, so partial state can never leak.
func (d *Decoder) validate(b *batchState) error {
	for table, ss := range b.schemas {
		if table == "" {
			return fmt.Errorf("schema event: %w: empty table name", ErrInvalidColumn)
		}
		var prev int64
		for i, s := range ss {
			if i > 0 {
				switch {
				case s.Generation == prev:
					return fmt.Errorf("table %s generation %d: %w", table, s.Generation, ErrDuplicateSchema)
				case s.Generation < prev:
					return fmt.Errorf("table %s generation %d follows %d: %w", table, s.Generation, prev, ErrGenerationOrder)
				}
			}
			prev = s.Generation
			if err := validateColumns(s.Columns); err != nil {
				return fmt.Errorf("table %s generation %d: %w", table, s.Generation, err)
			}
		}
		if prior := d.committed[table]; len(prior) > 0 && len(ss) > 0 {
			last := prior[len(prior)-1].Generation
			if ss[0].Generation <= last {
				return fmt.Errorf("table %s generation %d <= committed %d: %w",
					table, ss[0].Generation, last, ErrGenerationOrder)
			}
		}
	}

	for _, r := range b.rows {
		s, ok := d.resolve(r.Table, r.Generation)
		if !ok {
			return fmt.Errorf("row seq %d table %q generation %d: %w",
				r.Seq, r.Table, r.Generation, ErrUnknownGeneration)
		}
		if len(r.Values) != len(s.Columns) {
			return fmt.Errorf("row seq %d table %q: got %d values, schema has %d columns: %w",
				r.Seq, r.Table, len(r.Values), len(s.Columns), ErrArity)
		}
		for i, v := range r.Values {
			if err := checkValue(s.Columns[i], v); err != nil {
				return fmt.Errorf("row seq %d table %q column %q: %w",
					r.Seq, r.Table, s.Columns[i].ID, err)
			}
		}
	}
	return nil
}

func validateColumns(cols []Column) error {
	seen := make(map[string]struct{}, len(cols))
	for _, c := range cols {
		if c.ID == "" {
			return fmt.Errorf("%w: empty column id", ErrInvalidColumn)
		}
		if _, dup := seen[c.ID]; dup {
			return fmt.Errorf("%w: duplicate column id %q", ErrInvalidColumn, c.ID)
		}
		seen[c.ID] = struct{}{}
		switch c.Type {
		case TypeInt64, TypeString, TypeBool:
		default:
			return fmt.Errorf("%w: unsupported type kind %d for column %q", ErrInvalidColumn, c.Type, c.ID)
		}
	}
	return nil
}

func checkValue(c Column, v any) error {
	if v == nil {
		return nil
	}
	switch c.Type {
	case TypeInt64:
		if _, ok := v.(int64); !ok {
			return fmt.Errorf("%w: column %q expects int64, got %T", ErrTypeMismatch, c.ID, v)
		}
	case TypeString:
		if _, ok := v.(string); !ok {
			return fmt.Errorf("%w: column %q expects string, got %T", ErrTypeMismatch, c.ID, v)
		}
	case TypeBool:
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%w: column %q expects bool, got %T", ErrTypeMismatch, c.ID, v)
		}
	}
	return nil
}

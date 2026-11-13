package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sort"
)

// DefaultMaxRepetitions is used when WalkOptions.MaxRepetitions is zero.
const DefaultMaxRepetitions = 10

var (
	// ErrNilClient is returned when WalkTable is called without a client.
	ErrNilClient = errors.New("dataeng: nil bulk client")
	// ErrInvalidColumn is returned for an empty table column OID.
	ErrInvalidColumn = errors.New("dataeng: invalid table column")
	// ErrDuplicateColumn is returned when two columns have the same base OID.
	ErrDuplicateColumn = errors.New("dataeng: duplicate table column")
	// ErrMaxRequests is returned when a caller's request limit is reached.
	ErrMaxRequests = errors.New("dataeng: maximum request count reached")
)

// BulkClient performs one SNMP GetBulk request. Implementations should return
// variable bindings in the order supplied by the agent.
type BulkClient interface {
	GetBulk(ctx context.Context, oids []OID, nonRepeaters, maxRepetitions int) ([]VarBind, error)
}

// BulkClientFunc adapts a function to BulkClient.
type BulkClientFunc func(context.Context, []OID, int, int) ([]VarBind, error)

// GetBulk implements BulkClient.
func (f BulkClientFunc) GetBulk(ctx context.Context, oids []OID, nonRepeaters, maxRepetitions int) ([]VarBind, error) {
	return f(ctx, oids, nonRepeaters, maxRepetitions)
}

// BulkFunc adapts a context-free function to BulkClient.
type BulkFunc func([]OID, int, int) ([]VarBind, error)

// GetBulk implements BulkClient.
func (f BulkFunc) GetBulk(_ context.Context, oids []OID, nonRepeaters, maxRepetitions int) ([]VarBind, error) {
	return f(oids, nonRepeaters, maxRepetitions)
}

// WalkOptions controls table traversal.
type WalkOptions struct {
	// NonRepeaters is supplied to each GetBulk request. It is clamped to the
	// number of columns still being walked.
	NonRepeaters int
	// MaxRepetitions is supplied to each GetBulk request.
	MaxRepetitions int
	// MaxRows stops traversal after this many rows. Zero means unlimited.
	MaxRows int
	// MaxRequests stops traversal after this many requests. Zero means
	// unlimited; callers can use it as a hard guard against bad agents.
	MaxRequests int
}

// DefaultWalkOptions returns the options used by WalkTable.
func DefaultWalkOptions() WalkOptions {
	return WalkOptions{MaxRepetitions: DefaultMaxRepetitions}
}

// Option configures a table walk.
type Option func(*WalkOptions)

// WithNonRepeaters sets the GetBulk non-repeaters value.
func WithNonRepeaters(nonRepeaters int) Option {
	return func(options *WalkOptions) {
		options.NonRepeaters = nonRepeaters
	}
}

// WithMaxRepetitions sets the GetBulk max-repetitions value.
func WithMaxRepetitions(maxRepetitions int) Option {
	return func(options *WalkOptions) {
		options.MaxRepetitions = maxRepetitions
	}
}

// WithMaxRows limits the number of distinct rows returned.
func WithMaxRows(maxRows int) Option {
	return func(options *WalkOptions) {
		options.MaxRows = maxRows
	}
}

// WithMaxRequests limits the number of GetBulk requests.
func WithMaxRequests(maxRequests int) Option {
	return func(options *WalkOptions) {
		options.MaxRequests = maxRequests
	}
}

// WalkTable walks one or more table columns with GetBulk. Each column advances
// independently: endOfMibView, a non-increasing OID, an out-of-bounds OID, or
// an otherwise unusable response only terminates the affected column. Values
// are aligned by instance index, and columns missing an index leave a
// non-present Cell in that row.
func WalkTable(ctx context.Context, client BulkClient, columns []OID, options ...Option) (*Table, error) {
	walkOptions := DefaultWalkOptions()
	for _, option := range options {
		if option != nil {
			option(&walkOptions)
		}
	}
	return WalkTableWithOptions(ctx, client, columns, walkOptions)
}

// Walk is an alias for WalkTable.
func Walk(ctx context.Context, client BulkClient, columns []OID, options ...Option) (*Table, error) {
	return WalkTable(ctx, client, columns, options...)
}

// WalkTableWithOptions is WalkTable with an explicit option struct.
func WalkTableWithOptions(ctx context.Context, client BulkClient, columns []OID, options WalkOptions) (*Table, error) {
	if client == nil {
		return nil, ErrNilClient
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if options.MaxRepetitions == 0 {
		options.MaxRepetitions = DefaultMaxRepetitions
	}
	if err := options.validate(); err != nil {
		return nil, err
	}
	if err := validateColumns(columns); err != nil {
		return nil, err
	}

	walker := newWalker(client, columns, options)
	return walker.run(ctx)
}

func (options WalkOptions) validate() error {
	if options.NonRepeaters < 0 {
		return fmt.Errorf("dataeng: non-repeaters must not be negative: %d", options.NonRepeaters)
	}
	if options.MaxRepetitions < 0 {
		return fmt.Errorf("dataeng: max-repetitions must not be negative: %d", options.MaxRepetitions)
	}
	if options.MaxRows < 0 {
		return fmt.Errorf("dataeng: max rows must not be negative: %d", options.MaxRows)
	}
	if options.MaxRequests < 0 {
		return fmt.Errorf("dataeng: max requests must not be negative: %d", options.MaxRequests)
	}
	return nil
}

func validateColumns(columns []OID) error {
	seen := make(map[string]struct{}, len(columns))
	for i, column := range columns {
		if len(column) == 0 {
			return fmt.Errorf("%w at index %d", ErrInvalidColumn, i)
		}
		key := column.String()
		if _, exists := seen[key]; exists {
			return fmt.Errorf("%w %s", ErrDuplicateColumn, key)
		}
		seen[key] = struct{}{}
	}
	return nil
}

type walkColumn struct {
	base   OID
	cursor OID
	last   OID
	done   bool
}

type walker struct {
	client  BulkClient
	options WalkOptions
	columns []walkColumn
	sorted  []int
	rows    map[string]*Row
}

func newWalker(client BulkClient, columns []OID, options WalkOptions) *walker {
	walker := &walker{
		client:  client,
		options: options,
		columns: make([]walkColumn, len(columns)),
		sorted:  make([]int, len(columns)),
		rows:    make(map[string]*Row),
	}
	for i, column := range columns {
		walker.columns[i] = walkColumn{base: column.Clone(), cursor: column.Clone()}
		walker.sorted[i] = i
	}
	sort.SliceStable(walker.sorted, func(i, j int) bool {
		return walker.columns[walker.sorted[i]].base.Compare(walker.columns[walker.sorted[j]].base) < 0
	})
	return walker
}

func (w *walker) run(ctx context.Context) (*Table, error) {
	requests := 0
	for {
		if err := ctx.Err(); err != nil {
			return w.table(), err
		}

		active := w.activeColumns()
		if len(active) == 0 {
			break
		}
		if w.options.MaxRequests > 0 && requests >= w.options.MaxRequests {
			return w.table(), fmt.Errorf("%w: %d", ErrMaxRequests, requests)
		}

		requestOIDs := make([]OID, len(active))
		for i, column := range active {
			requestOIDs[i] = w.columns[column].cursor.Clone()
		}
		nonRepeaters := w.options.NonRepeaters
		if nonRepeaters > len(requestOIDs) {
			nonRepeaters = len(requestOIDs)
		}

		requests++
		response, err := w.client.GetBulk(ctx, requestOIDs, nonRepeaters, w.options.MaxRepetitions)
		if err != nil {
			return w.table(), fmt.Errorf("dataeng: getbulk: %w", err)
		}
		if len(response) == 0 {
			break
		}

		if !w.consume(response, active, nonRepeaters) {
			// A response that neither advances a column nor retires one
			// cannot make progress and would otherwise loop forever.
			break
		}
		if w.options.MaxRows > 0 && len(w.rows) >= w.options.MaxRows {
			break
		}
	}
	return w.table(), nil
}

func (w *walker) activeColumns() []int {
	active := make([]int, 0, len(w.columns))
	for i := range w.columns {
		if !w.columns[i].done {
			active = append(active, i)
		}
	}
	return active
}

// consume processes one response and reports whether any column advanced or
// was retired. A repeated response therefore changes state on its first
// duplicate and is then idempotent.
func (w *walker) consume(response []VarBind, request []int, nonRepeaters int) bool {
	changed := false
	for position, binding := range response {
		if len(binding.OID) == 0 {
			if column := intendedColumn(position, request, nonRepeaters); column >= 0 {
				if w.retire(column) {
					changed = true
				}
			}
			continue
		}

		column, suffix, matched := w.match(binding.OID)
		if matched && len(suffix) > 0 {
			if w.columns[column].done {
				continue
			}
			if binding.IsTerminal() {
				if w.retire(column) {
					changed = true
				}
				continue
			}
			if w.columns[column].last != nil &&
				binding.OID.Compare(w.columns[column].last) <= 0 {
				// Non-increasing OIDs terminate this column only. The same
				// value seen twice is ignored, which keeps retries idempotent.
				if w.retire(column) {
					changed = true
				}
				continue
			}
			if w.add(column, suffix, binding) {
				changed = true
			}
			w.columns[column].last = binding.OID.Clone()
			w.columns[column].cursor = binding.OID.Clone()
			continue
		}

		if matched {
			// An exact column base means the agent did not advance that
			// column. The OID itself identifies the affected column.
			if w.retire(column) {
				changed = true
			}
			continue
		}

		// The binding is outside every requested column. GetBulk reply order
		// identifies the column it was meant for; lexical adjacency is only a
		// fallback when the reply cannot be mapped by position.
		if column := intendedColumn(position, request, nonRepeaters); column >= 0 {
			if w.retire(column) {
				changed = true
			}
		} else if column := w.gapPredecessor(binding.OID); column >= 0 {
			if w.retire(column) {
				changed = true
			}
		}
	}
	return changed
}

func (w *walker) retire(column int) bool {
	if column < 0 || column >= len(w.columns) || w.columns[column].done {
		return false
	}
	w.columns[column].done = true
	return true
}

// match returns the longest column base that prefixes oid. The suffix may be
// empty when oid equals a column base.
func (w *walker) match(oid OID) (int, OID, bool) {
	best := -1
	for i := range w.columns {
		base := w.columns[i].base
		if len(oid) < len(base) || !oid.HasPrefix(base) {
			continue
		}
		if best < 0 || len(base) > len(w.columns[best].base) {
			best = i
		}
	}
	if best < 0 {
		return -1, nil, false
	}
	return best, oid[len(w.columns[best].base):], true
}

// intendedColumn maps a response position to a requested column using the
// GetBulk reply layout: non-repeaters first, then repetitions in request order.
func intendedColumn(position int, request []int, nonRepeaters int) int {
	if len(request) == 0 {
		return -1
	}
	if nonRepeaters > len(request) {
		nonRepeaters = len(request)
	}
	if position < nonRepeaters {
		return request[position]
	}
	repeaters := len(request) - nonRepeaters
	if repeaters <= 0 {
		return -1
	}
	return request[nonRepeaters+(position-nonRepeaters)%repeaters]
}

// gapPredecessor returns the column whose subtree immediately precedes oid in
// lexicographic order. An OID in that gap is out of bounds for the column and
// means the agent has moved past the end of that column's table.
func (w *walker) gapPredecessor(oid OID) int {
	if len(oid) == 0 {
		return -1
	}

	// A short ancestor OID is not evidence that a column is exhausted.
	for _, column := range w.sorted {
		base := w.columns[column].base
		if len(base) > len(oid) && base.HasPrefix(oid) {
			return -1
		}
	}

	count := 0
	for _, column := range w.sorted {
		if w.columns[column].base.Compare(oid) < 0 {
			count++
			continue
		}
		break
	}
	if count == 0 {
		return -1
	}
	return w.sorted[count-1]
}

func (w *walker) add(column int, suffix OID, binding VarBind) bool {
	key := suffix.String()
	row, exists := w.rows[key]
	if !exists {
		if w.options.MaxRows > 0 && len(w.rows) >= w.options.MaxRows {
			return false
		}
		row = &Row{
			Index: suffix.Clone(),
			Cells: make([]Cell, len(w.columns)),
		}
		for i := range w.columns {
			row.Cells[i] = Cell{
				ColumnIndex: i,
				Column:      w.columns[i].base.Clone(),
			}
		}
		w.rows[key] = row
	}

	cell := &row.Cells[column]
	if cell.Present {
		return false
	}
	cell.OID = binding.OID.Clone()
	cell.Type = binding.Type
	cell.Value = cloneValue(binding.Value)
	cell.Present = true
	return true
}

func cloneValue(value any) any {
	if bytes, ok := value.([]byte); ok {
		return append([]byte(nil), bytes...)
	}
	return value
}

func (w *walker) table() *Table {
	table := &Table{
		Columns: make([]OID, len(w.columns)),
		Rows:    make([]Row, 0, len(w.rows)),
	}
	for i := range w.columns {
		table.Columns[i] = w.columns[i].base.Clone()
	}
	for _, row := range w.rows {
		table.Rows = append(table.Rows, *row)
	}
	sort.Slice(table.Rows, func(i, j int) bool {
		return table.Rows[i].Index.Compare(table.Rows[j].Index) < 0
	})
	return table
}

// Package pivot turns (rowKey, columnKey, value) observations into a wide
// table with a dynamically growing, byte-ordered column schema.
//
// Observations carry a unique ID. Reusing an ID (in any cell) or revoking an
// ID that does not exist is rejected. When several observations land in the
// same cell, the one with the greatest ID in byte order wins; revoking it
// reveals the next one. Operations are applied in atomic batches: any illegal
// operation rolls the whole batch back.
//
// Views are immutable snapshots. Missing cells are reported as Missing and
// are never conflated with explicit null values. Rows and columns exist in
// the schema exactly while at least one of their observations is still live.
package pivot

import (
	"errors"
	"fmt"
	"sort"
)

var (
	// ErrDuplicateID is returned when an added observation reuses the ID of
	// a live observation, whether in the same cell or across cells.
	ErrDuplicateID = errors.New("pivot: duplicate observation ID")
	// ErrMissingID is returned when a revoke names an ID that is not live.
	ErrMissingID = errors.New("pivot: revoke of unknown observation ID")
)

// Observation is a single (rowKey, columnKey, value) fact. ID is unique
// across the whole table and also orders competing observations inside a
// cell by byte order. A nil Value is an explicit null.
type Observation struct {
	ID     string
	RowKey string
	ColKey string
	Value  *string
}

// Op is one mutation inside a batch.
type Op struct {
	// Revoke selects revocation of RevokeID; otherwise Obs is added.
	Revoke   bool
	Obs      Observation
	RevokeID string
}

// Add returns an Op that adds obs.
func Add(obs Observation) Op { return Op{Obs: obs} }

// Revoke returns an Op that revokes the observation with the given ID.
func Revoke(id string) Op { return Op{Revoke: true, RevokeID: id} }

// Kind distinguishes missing cells from explicit nulls and values.
type Kind int

const (
	// Missing means no live observation exists for the cell.
	Missing Kind = iota
	// Null means the winning observation carries an explicit null value.
	Null
	// Value means the winning observation carries a non-null value.
	Value
)

func (k Kind) String() string {
	switch k {
	case Missing:
		return "missing"
	case Null:
		return "null"
	default:
		return "value"
	}
}

// Cell is one wide-table cell.
type Cell struct {
	Kind  Kind
	Value string // meaningful only when Kind == Value
}

// View is an immutable wide-table snapshot. Schema and Rows are byte-ordered.
type View struct {
	Schema []string
	Rows   []string
	Cells  [][]Cell // Cells[row][column]
}

// Cell returns the cell at (rowKey, colKey), or Missing when either key is
// absent from the view.
func (v *View) Cell(rowKey, colKey string) Cell {
	ri := sort.SearchStrings(v.Rows, rowKey)
	if ri >= len(v.Rows) || v.Rows[ri] != rowKey {
		return Cell{Kind: Missing}
	}
	ci := sort.SearchStrings(v.Schema, colKey)
	if ci >= len(v.Schema) || v.Schema[ci] != colKey {
		return Cell{Kind: Missing}
	}
	return v.Cells[ri][ci]
}

// SchemaChange describes how the column schema moved during a batch.
type SchemaChange struct {
	// Schema is the new byte-ordered column schema.
	Schema []string
	// Mapping has one entry per old schema column: the column's index in
	// the new schema, or -1 when the column no longer exists.
	Mapping []int
}

// Table holds the live observation set and the current column schema.
type Table struct {
	obs        map[string]Observation // id -> observation
	cell       map[string][]string    // rowKey+"\x00"+colKey -> IDs, byte-sorted
	rows       map[string]int         // rowKey -> live observation count
	cols       map[string]int         // colKey -> live observation count
	colsSorted []string               // cached byte-ordered column schema
	dirty      bool                   // colsSorted needs a rebuild
}

// New returns an empty Table.
func New() *Table {
	return &Table{
		obs:  make(map[string]Observation),
		cell: make(map[string][]string),
		rows: make(map[string]int),
		cols: make(map[string]int),
	}
}

func cellKey(rowKey, colKey string) string { return rowKey + "\x00" + colKey }

// Apply applies a batch atomically. If any operation is illegal (duplicate
// observation ID, revoke of an unknown ID), the whole batch is rolled back
// and a non-nil error is returned. On success it reports the schema change
// relative to the schema before the batch.
func (t *Table) Apply(ops []Op) (SchemaChange, error) {
	oldSchema := t.schema()

	work := t.clone()
	for i, op := range ops {
		var err error
		if op.Revoke {
			err = work.revoke(op.RevokeID)
		} else {
			err = work.add(op.Obs)
		}
		if err != nil {
			return SchemaChange{}, fmt.Errorf("pivot: batch rolled back: op %d: %w", i, err)
		}
	}
	*t = *work

	newSchema := t.schema()
	mapping := make([]int, len(oldSchema))
	for i, key := range oldSchema {
		j := sort.SearchStrings(newSchema, key)
		if j < len(newSchema) && newSchema[j] == key {
			mapping[i] = j
		} else {
			mapping[i] = -1
		}
	}
	return SchemaChange{Schema: newSchema, Mapping: mapping}, nil
}

func (t *Table) add(obs Observation) error {
	if obs.ID == "" {
		return fmt.Errorf("%w: empty ID", ErrDuplicateID)
	}
	if _, ok := t.obs[obs.ID]; ok {
		return fmt.Errorf("%w: %q", ErrDuplicateID, obs.ID)
	}
	t.obs[obs.ID] = obs

	key := cellKey(obs.RowKey, obs.ColKey)
	ids := t.cell[key]
	i := sort.SearchStrings(ids, obs.ID)
	ids = append(ids, "")
	copy(ids[i+1:], ids[i:])
	ids[i] = obs.ID
	t.cell[key] = ids

	t.rows[obs.RowKey]++
	if t.cols[obs.ColKey] == 0 {
		t.dirty = true
	}
	t.cols[obs.ColKey]++
	return nil
}

func (t *Table) revoke(id string) error {
	obs, ok := t.obs[id]
	if !ok {
		return fmt.Errorf("%w: %q", ErrMissingID, id)
	}
	delete(t.obs, id)

	key := cellKey(obs.RowKey, obs.ColKey)
	ids := t.cell[key]
	i := sort.SearchStrings(ids, id)
	ids = append(ids[:i], ids[i+1:]...)
	if len(ids) == 0 {
		delete(t.cell, key)
	} else {
		t.cell[key] = ids
	}

	t.rows[obs.RowKey]--
	if t.rows[obs.RowKey] == 0 {
		delete(t.rows, obs.RowKey)
	}
	t.cols[obs.ColKey]--
	if t.cols[obs.ColKey] == 0 {
		delete(t.cols, obs.ColKey)
		t.dirty = true
	}
	return nil
}

// schema returns the current byte-ordered column schema.
func (t *Table) schema() []string {
	if t.dirty {
		t.colsSorted = t.colsSorted[:0]
		for key := range t.cols {
			t.colsSorted = append(t.colsSorted, key)
		}
		sort.Strings(t.colsSorted)
		t.dirty = false
	}
	out := make([]string, len(t.colsSorted))
	copy(out, t.colsSorted)
	return out
}

// View snapshots the current wide table. The view is immutable and keeps
// this schema even after later batches change the table.
func (t *Table) View() *View {
	schema := t.schema()
	colIndex := make(map[string]int, len(schema))
	for i, key := range schema {
		colIndex[key] = i
	}

	rows := make([]string, 0, len(t.rows))
	for key := range t.rows {
		rows = append(rows, key)
	}
	sort.Strings(rows)

	cells := make([][]Cell, len(rows))
	for ri, rowKey := range rows {
		cells[ri] = make([]Cell, len(schema)) // zero value: Missing
		for colKey, ci := range colIndex {
			ids := t.cell[cellKey(rowKey, colKey)]
			if len(ids) == 0 {
				continue
			}
			winner := t.obs[ids[len(ids)-1]]
			if winner.Value == nil {
				cells[ri][ci] = Cell{Kind: Null}
			} else {
				cells[ri][ci] = Cell{Kind: Value, Value: *winner.Value}
			}
		}
	}
	return &View{Schema: schema, Rows: rows, Cells: cells}
}

// Live returns the live observations in ID byte order, for full-rebuild
// verification.
func (t *Table) Live() []Observation {
	out := make([]Observation, 0, len(t.obs))
	for _, obs := range t.obs {
		out = append(out, obs)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (t *Table) clone() *Table {
	c := &Table{
		obs:        make(map[string]Observation, len(t.obs)),
		cell:       make(map[string][]string, len(t.cell)),
		rows:       make(map[string]int, len(t.rows)),
		cols:       make(map[string]int, len(t.cols)),
		colsSorted: append([]string(nil), t.colsSorted...),
		dirty:      t.dirty,
	}
	for k, v := range t.obs {
		c.obs[k] = v
	}
	for k, v := range t.cell {
		c.cell[k] = append([]string(nil), v...)
	}
	for k, v := range t.rows {
		c.rows[k] = v
	}
	for k, v := range t.cols {
		c.cols[k] = v
	}
	return c
}

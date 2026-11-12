package dataeng

import "fmt"

// Decoder rebuilds host rows from a columnar token stream fed in
// batches. Each DecodeBatch call is atomic: if any token in the batch
// is invalid, no row completed by that batch is published and the
// decoder state is rolled back to before the batch. Rows that were
// already completed by earlier batches stay published; the last,
// potentially incomplete row stays staged until the next token or
// Finalize.
type Decoder struct {
	validator *LevelValidator
	wantRows  int
	completed []Row
	current   *rowBuilder
	done      bool
}

type decoderState struct {
	validator validatorState
	completed []Row
	current   *rowBuilder
	done      bool
}

// NewDecoder creates a decoder expecting wantRows rows. wantRows must
// be non-negative; the count is only confirmed when Finalize is called.
func NewDecoder(wantRows int) (*Decoder, error) {
	if wantRows < 0 {
		return nil, fmt.Errorf("wantRows must be non-negative, got %d", wantRows)
	}
	return &Decoder{
		validator: NewLevelValidator(),
		wantRows:  wantRows,
	}, nil
}

// DecodeBatch validates and applies one batch. On success it returns
// the rows completed by this batch; any unfinished final row is staged
// rather than published. On failure it returns the validation error,
// publishes nothing, and restores the state captured before the batch.
func (d *Decoder) DecodeBatch(batch []Token) (published []Row, err error) {
	if d.done {
		return nil, fmt.Errorf("decoder is finalized and accepts no more batches")
	}

	snapshot := d.snapshot()
	completedBefore := len(d.completed)

	for _, tok := range batch {
		if err := d.validator.Next(tok); err != nil {
			d.restore(snapshot)
			return nil, err
		}
		if err := d.step(tok); err != nil {
			d.restore(snapshot)
			return nil, err
		}
	}

	published = d.completed[completedBefore:]
	if len(published) == 0 {
		return nil, nil
	}

	out := make([]Row, len(published))
	copy(out, published)
	return out, nil
}

// Finalize confirms the last row and the expected row count. It returns
// the staged final row, or nil when the last row was already returned
// by DecodeBatch. After Finalize the decoder accepts no more batches.
func (d *Decoder) Finalize() ([]Row, error) {
	if d.done {
		return nil, fmt.Errorf("decoder is already finalized")
	}
	if err := d.validator.End(d.wantRows); err != nil {
		return nil, err
	}

	var final []Row
	if d.current != nil {
		final = []Row{d.current.toRow()}
		d.current = nil
	}

	d.done = true
	return final, nil
}

func (d *Decoder) step(tok Token) error {
	if tok.R == 0 {
		if d.current != nil {
			d.completed = append(d.completed, d.current.toRow())
		}
		d.current = newRowBuilder(tok)
		return nil
	}

	if d.current == nil {
		return fmt.Errorf("token with r=%d arrives before the first row", tok.R)
	}

	switch tok.R {
	case 1:
		d.current.appendOuter(tok)
	case 2:
		d.current.appendLeaf(tok)
	}
	return nil
}

// rowBuilder accumulates one row. outer is nil for d in {0,1}; when
// non-nil, currentInner distinguishes a null outer element (nil) from
// an empty inner list (a non-nil empty slice).
type rowBuilder struct {
	outer        *[][]*int64
	currentInner []*int64
}

func newRowBuilder(tok Token) *rowBuilder {
	builder := &rowBuilder{}
	switch tok.D {
	case 0:
	case 1:
		outer := make([][]*int64, 0)
		builder.outer = &outer
	case 2:
		outer := make([][]*int64, 0, 1)
		builder.outer = &outer
		*builder.outer = append(outer, nil)
	case 3:
		outer := make([][]*int64, 0, 1)
		builder.outer = &outer
		builder.currentInner = make([]*int64, 0)
		*builder.outer = append(outer, builder.currentInner)
	case 4:
		outer := make([][]*int64, 0, 1)
		builder.outer = &outer
		builder.currentInner = make([]*int64, 0, 1)
		*builder.outer = append(outer, builder.currentInner)
		builder.currentInner = append(builder.currentInner, nil)
		(*builder.outer)[len(*builder.outer)-1] = builder.currentInner
	case 5:
		outer := make([][]*int64, 0, 1)
		builder.outer = &outer
		builder.currentInner = make([]*int64, 0, 1)
		*builder.outer = append(outer, builder.currentInner)
		builder.currentInner = append(builder.currentInner, copyValue(tok.Value))
		(*builder.outer)[len(*builder.outer)-1] = builder.currentInner
	}
	return builder
}

func (b *rowBuilder) appendOuter(tok Token) {
	switch tok.D {
	case 2:
		b.currentInner = nil
		*b.outer = append(*b.outer, nil)
	case 3:
		b.currentInner = make([]*int64, 0)
		*b.outer = append(*b.outer, b.currentInner)
	case 4:
		b.currentInner = make([]*int64, 0, 1)
		*b.outer = append(*b.outer, b.currentInner)
		b.currentInner = append(b.currentInner, nil)
		(*b.outer)[len(*b.outer)-1] = b.currentInner
	case 5:
		b.currentInner = make([]*int64, 0, 1)
		*b.outer = append(*b.outer, b.currentInner)
		b.currentInner = append(b.currentInner, copyValue(tok.Value))
		(*b.outer)[len(*b.outer)-1] = b.currentInner
	}
}

func (b *rowBuilder) appendLeaf(tok Token) {
	if tok.D == 4 {
		b.currentInner = append(b.currentInner, nil)
		(*b.outer)[len(*b.outer)-1] = b.currentInner
		return
	}
	b.currentInner = append(b.currentInner, copyValue(tok.Value))
	(*b.outer)[len(*b.outer)-1] = b.currentInner
}

func (b *rowBuilder) toRow() Row {
	if b.outer == nil {
		return Row{}
	}

	outerCopy := make([][]*int64, len(*b.outer))
	for i, inner := range *b.outer {
		if inner == nil {
			continue
		}
		innerCopy := make([]*int64, len(inner))
		for j, leaf := range inner {
			innerCopy[j] = copyValue(leaf)
		}
		outerCopy[i] = innerCopy
	}
	return Row{Outer: &outerCopy}
}

func (b *rowBuilder) clone() *rowBuilder {
	if b == nil {
		return nil
	}
	cloned := newRowBuilder(Token{D: 0})
	if b.outer == nil {
		return cloned
	}

	outer := make([][]*int64, len(*b.outer))
	for i, inner := range *b.outer {
		if inner == nil {
			continue
		}
		leaves := make([]*int64, len(inner))
		for j, leaf := range inner {
			leaves[j] = copyValue(leaf)
		}
		outer[i] = leaves
	}
	cloned.outer = &outer

	// The current inner list is always the last non-nil outer element;
	// a null current outer element leaves currentInner nil, and the
	// validator forbids r=2 until a new element starts.
	for i := len(outer) - 1; i >= 0; i-- {
		if outer[i] != nil {
			cloned.currentInner = outer[i]
			break
		}
	}
	return cloned
}

func (d *Decoder) snapshot() decoderState {
	completed := make([]Row, len(d.completed))
	copy(completed, d.completed)
	return decoderState{
		validator: d.validator.snapshot(),
		completed: completed,
		current:   d.current.clone(),
		done:      d.done,
	}
}

func (d *Decoder) restore(state decoderState) {
	d.validator.restore(state.validator)
	d.completed = state.completed
	d.current = state.current
	d.done = state.done
}

// DecodeAll validates and decodes a complete token stream in one call.
func DecodeAll(tokens []Token, wantRows int) ([]Row, error) {
	decoder, err := NewDecoder(wantRows)
	if err != nil {
		return nil, err
	}
	published, err := decoder.DecodeBatch(tokens)
	if err != nil {
		return nil, err
	}
	final, err := decoder.Finalize()
	if err != nil {
		return nil, err
	}
	rows := append(published, final...)
	if len(rows) == 0 {
		return nil, nil
	}
	return rows, nil
}

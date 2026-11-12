package mergejoin

import (
	"context"
)

// sideConfig carries the per-side budget evaluation.
type sideConfig[P any] struct {
	maxRows  int
	maxBytes int64
	sizer    Sizer[P]
}

// groupSide accumulates one key's rows from one side until the budget is
// crossed, after which every row goes straight to the staging writer.
type groupSide[P any] struct {
	cfg       sideConfig[P]
	key       int64
	newWriter func(context.Context, int64) (StagingWriter[P], error)

	mem     []Row[P]
	bytes   int64
	spilled bool
	count   int

	writer StagingWriter[P]
}

func newGroupSide[P any](
	cfg sideConfig[P],
	key int64,
	newWriter func(context.Context, int64) (StagingWriter[P], error),
) *groupSide[P] {
	return &groupSide[P]{cfg: cfg, key: key, newWriter: newWriter}
}

// add inserts one row, lazily opening the staging writer and flushing the
// in-memory buffer on the exact call that crosses the budget.
func (g *groupSide[P]) add(ctx context.Context, row Row[P]) error {
	g.count++

	if g.spilled {
		return g.writer.Append(ctx, row)
	}

	g.mem = append(g.mem, row)
	if g.cfg.sizer != nil {
		g.bytes += int64(g.cfg.sizer(row))
	}

	if !g.overBudget() {
		return nil
	}

	g.spilled = true
	if err := g.openAndFlush(ctx); err != nil {
		return err
	}
	return nil
}

// openAndFlush creates the side's staging writer for the key and moves the
// buffered rows into it, releasing the in-memory buffer.
func (g *groupSide[P]) openAndFlush(ctx context.Context) error {
	writer, err := g.newWriter(ctx, g.key)
	if err != nil {
		return err
	}
	g.writer = writer
	return g.flush(ctx)
}

func (g *groupSide[P]) overBudget() bool {
	if g.cfg.maxRows > 0 && len(g.mem) > g.cfg.maxRows {
		return true
	}
	if g.cfg.maxBytes > 0 && g.bytes > g.cfg.maxBytes {
		return true
	}
	return false
}

// flush writes the buffered rows to the writer and releases the buffer.
func (g *groupSide[P]) flush(ctx context.Context) error {
	for _, row := range g.mem {
		if err := g.writer.Append(ctx, row); err != nil {
			return err
		}
	}
	g.mem = nil
	g.bytes = 0
	return nil
}

// closeWriter finalizes the staging writer when the group was spilled.
func (g *groupSide[P]) closeWriter() error {
	if !g.spilled || g.writer == nil {
		return nil
	}
	return g.writer.Close()
}

// rowSource is the uniform read interface used by the nested loop, backed
// either by the in-memory buffer or a replayable staging reader.
type rowSource[P any] interface {
	next(ctx context.Context) (Row[P], error)
	rewind() error
	close(ctx context.Context) error
}

type memSource[P any] struct {
	rows []Row[P]
	pos  int
}

func (m *memSource[P]) next(_ context.Context) (Row[P], error) {
	if m.pos >= len(m.rows) {
		return Row[P]{}, errEOF()
	}
	row := m.rows[m.pos]
	m.pos++
	return row, nil
}

func (m *memSource[P]) rewind() error {
	m.pos = 0
	return nil
}

func (m *memSource[P]) close(_ context.Context) error { return nil }

type stageSource[P any] struct {
	reader StagingReader[P]
}

func (s *stageSource[P]) next(ctx context.Context) (Row[P], error) {
	return s.reader.Next(ctx)
}

func (s *stageSource[P]) rewind() error {
	return s.reader.Rewind()
}

func (s *stageSource[P]) close(ctx context.Context) error {
	if err := s.reader.Discard(ctx); err != nil {
		s.reader.Close()
		return err
	}
	return s.reader.Close()
}

func buildMemSource[P any](group *groupSide[P]) rowSource[P] {
	return &memSource[P]{rows: group.mem}
}

func buildStageSource[P any](group *groupSide[P], reader StagingReader[P]) rowSource[P] {
	return &stageSource[P]{reader: reader}
}

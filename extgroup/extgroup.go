// Package extgroup performs external-memory grouping of log rows.
//
// Rows carry a string group key, an arbitrary-precision integer value and a
// monotonically increasing source sequence number. At most Config.B rows are
// held in memory; once the cache is full the rows are spilled to temporary
// segments produced by an injected SegmentFactory. Finish merges every
// spilled segment back and emits, in group key byte order, the per-key sum and
// the list of source sequence numbers, which is delivered through a streaming
// callback instead of a retained slice.
//
// A group is only published after all of its rows have been read back from the
// segments without error. On cancellation or any segment read/write failure
// every temporary segment is closed and released.
package extgroup

import (
	"container/heap"
	"context"
	"errors"
	"io"
	"math/big"
)

// ErrFinished is returned when an Aggregator is used after Finish, Discard or
// after it has aborted due to a failure.
var ErrFinished = errors.New("extgroup: aggregator already finished or aborted")

// Row is a single input record.
type Row struct {
	Key   string
	Value *big.Int
	Seq   uint64
}

// RowWriter appends rows to a temporary segment.
type RowWriter interface {
	WriteRow(context.Context, Row) error
	Close(context.Context) error
}

// RowReader streams rows back from a temporary segment in key, then sequence
// order. It returns io.EOF when no more rows are available.
type RowReader interface {
	Next(context.Context) (Row, error)
	Close(context.Context) error
}

// Segment is one spilled, sorted run of rows.
type Segment interface {
	Writer(context.Context) (RowWriter, error)
	Reader(context.Context) (RowReader, error)
	// Release deletes and frees all resources backing the segment. It must be
	// safe to invoke after readers and writers have been closed.
	Release(context.Context) error
}

// SegmentFactory constructs temporary segments.
type SegmentFactory interface {
	NewSegment(context.Context) (Segment, error)
}

// EmitSeq returns the i-th source sequence number (in ascending order) of the
// group being published. It returns io.EOF when i is out of range.
type EmitSeq func(i int) (uint64, error)

// GroupSink receives completed groups in key byte order.
type GroupSink interface {
	EmitGroup(ctx context.Context, key string, sum *big.Int, emit EmitSeq) error
}

// Config configures an Aggregator.
type Config struct {
	// B is the maximum number of rows buffered in memory; it must be positive.
	B        int
	Segments SegmentFactory
	Sink     GroupSink
}

// Aggregator groups rows with bounded memory using spilled segments.
type Aggregator struct {
	cfg     Config
	buf     []Row
	segs    []*openSegment
	done    bool
	aborted bool
}

type openSegment struct {
	seg      Segment
	released bool
}

// NewAggregator validates the configuration and returns an empty Aggregator.
func NewAggregator(cfg Config) (*Aggregator, error) {
	if cfg.B <= 0 {
		return nil, errors.New("extgroup: B must be positive")
	}
	if cfg.Segments == nil {
		return nil, errors.New("extgroup: nil SegmentFactory")
	}
	if cfg.Sink == nil {
		return nil, errors.New("extgroup: nil GroupSink")
	}
	return &Aggregator{
		cfg: cfg,
		buf: make([]Row, 0, cfg.B),
	}, nil
}

// Add buffers one row. When the in-memory cache reaches B rows it is spilled to
// a new segment before returning. On failure or cancellation the aggregator
// aborts and releases every segment it created.
func (a *Aggregator) Add(ctx context.Context, row Row) error {
	if a.done || a.aborted {
		return ErrFinished
	}
	if err := ctx.Err(); err != nil {
		a.abort()
		return err
	}
	if row.Value == nil {
		return errors.New("extgroup: row has nil Value")
	}
	// Copy the value so later mutation by the caller cannot change stored data.
	value := new(big.Int).Set(row.Value)
	a.buf = append(a.buf, Row{Key: row.Key, Value: value, Seq: row.Seq})
	if len(a.buf) >= a.cfg.B {
		return a.spill(ctx)
	}
	return nil
}

// spill writes the whole cache into one sorted segment and clears the cache.
func (a *Aggregator) spill(ctx context.Context) error {
	seg, err := a.cfg.Segments.NewSegment(ctx)
	if err != nil {
		a.abort()
		return err
	}
	open := &openSegment{seg: seg}
	a.segs = append(a.segs, open)

	writer, err := seg.Writer(ctx)
	if err != nil {
		a.abort()
		return err
	}
	writeErr := error(nil)
	for i := range a.buf {
		if err := writer.WriteRow(ctx, a.buf[i]); err != nil {
			writeErr = err
			break
		}
	}
	if closeErr := writer.Close(ctx); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		a.abort()
		return writeErr
	}
	a.buf = a.buf[:0]
	return nil
}

// Finish spills any buffered rows, reads every segment back, merges the groups
// in key byte order and publishes them to the sink. All segments are released
// before returning, including on failure.
func (a *Aggregator) Finish(ctx context.Context) error {
	if a.done || a.aborted {
		return ErrFinished
	}
	a.done = true

	// Every row, including the final partial cache, must be round-tripped
	// through a segment before a group can be published.
	if len(a.buf) > 0 {
		if err := a.spill(ctx); err != nil {
			return err
		}
	}
	if len(a.segs) == 0 {
		return a.releaseAll(ctx)
	}
	if err := a.mergeAndEmit(ctx); err != nil {
		a.releaseAll(context.WithoutCancel(context.Background()))
		return err
	}
	return a.releaseAll(ctx)
}

// Discard abandons the aggregator and releases every temporary segment.
func (a *Aggregator) Discard() {
	a.done = true
	a.aborted = true
	a.releaseAll(context.WithoutCancel(context.Background()))
}

// abort marks the aggregator unusable and releases all segments.
func (a *Aggregator) abort() {
	a.aborted = true
	a.releaseAll(context.WithoutCancel(context.Background()))
}

// releaseAll releases every segment exactly once, joining any errors.
func (a *Aggregator) releaseAll(ctx context.Context) error {
	var errs []error
	for _, open := range a.segs {
		if open.released {
			continue
		}
		open.released = true
		if err := open.seg.Release(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// heapEntry pairs a row with the reader index it came from.
type heapEntry struct {
	row Row
	idx int
}

type entryHeap []heapEntry

func (h entryHeap) Len() int { return len(h) }

func (h entryHeap) Less(i, j int) bool {
	if h[i].row.Key != h[j].row.Key {
		return h[i].row.Key < h[j].row.Key
	}
	return h[i].row.Seq < h[j].row.Seq
}

func (h entryHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *entryHeap) Push(x any) { *h = append(*h, x.(heapEntry)) }

func (h *entryHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	*h = old[:n-1]
	return item
}

// mergeAndEmit opens every segment, k-way merges its rows and publishes
// completed groups. A group is flushed only when the next group key appears or
// all readers are exhausted, so no group is published before every one of its
// rows has been read back successfully.
func (a *Aggregator) mergeAndEmit(ctx context.Context) (retErr error) {
	readers := make([]RowReader, len(a.segs))
	defer func() {
		for _, reader := range readers {
			if reader == nil {
				continue
			}
			if err := reader.Close(context.WithoutCancel(context.Background())); err != nil && retErr == nil {
				retErr = err
			}
		}
	}()

	h := make(entryHeap, 0, len(a.segs))
	for i, open := range a.segs {
		reader, err := open.seg.Reader(ctx)
		if err != nil {
			return err
		}
		readers[i] = reader
		row, err := reader.Next(ctx)
		if errors.Is(err, io.EOF) {
			continue
		}
		if err != nil {
			return err
		}
		h = append(h, heapEntry{row: row, idx: i})
	}
	heap.Init(&h)

	var (
		curKey string
		sum    *big.Int
		seqs   []uint64
		have   bool
	)

	flush := func() error {
		if !have {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		groupSeqs := seqs
		err := a.cfg.Sink.EmitGroup(ctx, curKey, sum, func(i int) (uint64, error) {
			if i < 0 || i >= len(groupSeqs) {
				return 0, io.EOF
			}
			return groupSeqs[i], nil
		})
		if err != nil {
			return err
		}
		seqs = seqs[:0]
		sum = nil
		have = false
		return nil
	}

	for h.Len() > 0 {
		top := heap.Pop(&h).(heapEntry)
		if !have || top.row.Key != curKey {
			if err := flush(); err != nil {
				return err
			}
			curKey = top.row.Key
			sum = new(big.Int).Set(top.row.Value)
			seqs = append(seqs[:0], top.row.Seq)
			have = true
		} else {
			sum.Add(sum, top.row.Value)
			seqs = append(seqs, top.row.Seq)
		}

		next, err := readers[top.idx].Next(ctx)
		if errors.Is(err, io.EOF) {
			continue
		}
		if err != nil {
			return err
		}
		heap.Push(&h, heapEntry{row: next, idx: top.idx})
	}
	return flush()
}

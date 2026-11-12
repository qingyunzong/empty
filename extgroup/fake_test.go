package extgroup

import (
	"context"
	"errors"
	"io"
	"sort"
	"sync"
)

var errEOF = io.EOF

// fakeSegment is an in-memory temporary segment. Rows are sorted on writer
// close, mirroring a spilled sorted run. Every open/close/release event is
// recorded so tests can assert resource reclamation.
type fakeSegment struct {
	id int

	mu sync.Mutex

	factory *fakeFactory

	rows         []Row
	writerOpen   bool
	writerClosed bool
	readerOpen   bool
	readerClosed bool
	released     bool

	writerWrites int
	readerReads  int
}

type fakeWriter struct {
	seg *fakeSegment
}

func (w *fakeWriter) WriteRow(_ context.Context, row Row) error {
	w.seg.mu.Lock()
	defer w.seg.mu.Unlock()
	if w.seg.writerClosed {
		return errors.New("fake: write after close")
	}
	if w.seg.factory.writeErrAt >= 0 && w.seg.writerWrites >= w.seg.factory.writeErrAt {
		return errors.New("fake: injected write failure")
	}
	w.seg.writerWrites++
	w.seg.rows = append(w.seg.rows, row)
	return nil
}

func (w *fakeWriter) Close(_ context.Context) error {
	w.seg.mu.Lock()
	defer w.seg.mu.Unlock()
	if w.seg.writerClosed {
		return nil
	}
	w.seg.writerClosed = true
	w.seg.writerOpen = false
	sort.Slice(w.seg.rows, func(i, j int) bool {
		if w.seg.rows[i].Key != w.seg.rows[j].Key {
			return w.seg.rows[i].Key < w.seg.rows[j].Key
		}
		return w.seg.rows[i].Seq < w.seg.rows[j].Seq
	})
	return nil
}

type fakeReader struct {
	seg *fakeSegment
	pos int
}

func (r *fakeReader) Next(_ context.Context) (Row, error) {
	r.seg.mu.Lock()
	defer r.seg.mu.Unlock()
	if r.seg.factory.readErrAt >= 0 && r.seg.readerReads >= r.seg.factory.readErrAt {
		return Row{}, errors.New("fake: injected read failure")
	}
	if r.pos >= len(r.seg.rows) {
		return Row{}, errEOF
	}
	r.seg.readerReads++
	row := r.seg.rows[r.pos]
	r.pos++
	return row, nil
}

func (r *fakeReader) Close(_ context.Context) error {
	r.seg.mu.Lock()
	defer r.seg.mu.Unlock()
	if r.seg.readerClosed {
		return nil
	}
	r.seg.readerClosed = true
	r.seg.readerOpen = false
	return nil
}

func (s *fakeSegment) Writer(_ context.Context) (RowWriter, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.factory.writerOpenFailOn[s.id] {
		return nil, errors.New("fake: injected writer open failure")
	}
	s.writerOpen = true
	return &fakeWriter{seg: s}, nil
}

func (s *fakeSegment) Reader(_ context.Context) (RowReader, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.factory.readerOpenFailOn[s.id] {
		return nil, errors.New("fake: injected reader open failure")
	}
	s.readerOpen = true
	return &fakeReader{seg: s}, nil
}

func (s *fakeSegment) Release(_ context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.released {
		return errors.New("fake: double release")
	}
	s.released = true
	s.rows = nil
	return nil
}

type fakeFactory struct {
	mu sync.Mutex

	segs []*fakeSegment

	newErrAt         int // fail when creating the segment with this id; -1 disables
	writerOpenFailOn map[int]bool
	readerOpenFailOn map[int]bool
	writeErrAt       int // fail once a writer reaches this many writes; -1 disables
	readErrAt        int // fail once a reader reaches this many reads; -1 disables
}

func newFakeFactory() *fakeFactory {
	return &fakeFactory{
		newErrAt:         -1,
		writerOpenFailOn: map[int]bool{},
		readerOpenFailOn: map[int]bool{},
		writeErrAt:       -1,
		readErrAt:        -1,
	}
}

func (f *fakeFactory) NewSegment(_ context.Context) (Segment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := len(f.segs)
	if f.newErrAt == id {
		return nil, errors.New("fake: injected new segment failure")
	}
	seg := &fakeSegment{id: id, factory: f}
	f.segs = append(f.segs, seg)
	return seg, nil
}

// snapshot returns the current segments without exposing internal locks.
func (f *fakeFactory) snapshot() []*fakeSegment {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*fakeSegment, len(f.segs))
	copy(out, f.segs)
	return out
}

// assertAllReleased fails the test if any segment leaks a resource.
func (f *fakeFactory) assertAllReleased(t testingT) {
	t.Helper()
	for _, seg := range f.snapshot() {
		seg.mu.Lock()
		switch {
		case !seg.released:
			t.Errorf("segment %d not released", seg.id)
		case seg.writerOpen:
			t.Errorf("segment %d writer still open", seg.id)
		case seg.readerOpen:
			t.Errorf("segment %d reader still open", seg.id)
		case seg.rows != nil:
			t.Errorf("segment %d rows not cleared on release", seg.id)
		}
		seg.mu.Unlock()
	}
}

type testingT interface {
	Errorf(format string, args ...any)
	Helper()
}

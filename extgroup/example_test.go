package extgroup_test

import (
	"context"
	"fmt"
	"io"
	"math/big"
	"sort"

	"example.org/dataeng/q0167/extgroup"
)

// memSegment is a minimal SegmentFactory implementation a log aggregation
// host could provide; here it keeps spilled rows in memory, sorted on close.
type memSegment struct{ rows []extgroup.Row }

type memWriter struct{ seg *memSegment }

func (w *memWriter) WriteRow(_ context.Context, row extgroup.Row) error {
	w.seg.rows = append(w.seg.rows, row)
	return nil
}

func (w *memWriter) Close(_ context.Context) error {
	sort.Slice(w.seg.rows, func(i, j int) bool {
		if w.seg.rows[i].Key != w.seg.rows[j].Key {
			return w.seg.rows[i].Key < w.seg.rows[j].Key
		}
		return w.seg.rows[i].Seq < w.seg.rows[j].Seq
	})
	return nil
}

type memReader struct {
	seg *memSegment
	pos int
}

func (r *memReader) Next(_ context.Context) (extgroup.Row, error) {
	if r.pos >= len(r.seg.rows) {
		return extgroup.Row{}, io.EOF
	}
	row := r.seg.rows[r.pos]
	r.pos++
	return row, nil
}

func (r *memReader) Close(_ context.Context) error { return nil }

func (s *memSegment) Writer(context.Context) (extgroup.RowWriter, error) {
	return &memWriter{seg: s}, nil
}

func (s *memSegment) Reader(context.Context) (extgroup.RowReader, error) {
	return &memReader{seg: s}, nil
}

func (s *memSegment) Release(context.Context) error {
	s.rows = nil
	return nil
}

type memFactory []*memSegment

func (f *memFactory) NewSegment(context.Context) (extgroup.Segment, error) {
	seg := &memSegment{}
	*f = append(*f, seg)
	return seg, nil
}

type printSink struct{}

func (printSink) EmitGroup(_ context.Context, key string, sum *big.Int, emit extgroup.EmitSeq) error {
	fmt.Printf("%s sum=%s seqs=[", key, sum)
	for i := 0; ; i++ {
		seq, err := emit(i)
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if i > 0 {
			fmt.Print(" ")
		}
		fmt.Print(seq)
	}
	fmt.Println("]")
	return nil
}

func ExampleAggregator() {
	factory := &memFactory{}
	agg, err := extgroup.NewAggregator(extgroup.Config{
		B:        2,
		Segments: factory,
		Sink:     printSink{},
	})
	if err != nil {
		panic(err)
	}

	rows := []extgroup.Row{
		{Key: "b", Value: big.NewInt(1), Seq: 0},
		{Key: "a", Value: big.NewInt(10), Seq: 1},
		{Key: "b", Value: big.NewInt(2), Seq: 2},
		{Key: "a", Value: big.NewInt(20), Seq: 3},
	}
	for _, row := range rows {
		if err := agg.Add(context.Background(), row); err != nil {
			panic(err)
		}
	}
	if err := agg.Finish(context.Background()); err != nil {
		panic(err)
	}

	for _, seg := range *factory {
		if seg.rows != nil {
			panic("segment not released")
		}
	}
	// Output:
	// a sum=30 seqs=[1 3]
	// b sum=3 seqs=[0 2]
}

package dataeng

import (
	"errors"
	"reflect"
	"testing"
)

func wm(v uint64) *uint64 { return &v }

func put(key string, seq uint64, payload string) Record {
	return Record{Key: key, Seq: seq, Op: OpPut, Payload: []byte(payload)}
}

func del(key string, seq uint64) Record {
	return Record{Key: key, Seq: seq, Op: OpDelete}
}

func TestMergeBasicAcrossSegments(t *testing.T) {
	got, err := Merge([][]Record{
		{put("a", 1, "x"), put("c", 1, "y")},
		{put("a", 2, "z"), put("b", 1, "w")},
	}, wm(10))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	want := []Entry{
		{Key: "a", Seq: 2, Op: OpPut, Payload: []byte("z")},
		{Key: "b", Seq: 1, Op: OpPut, Payload: []byte("w")},
		{Key: "c", Seq: 1, Op: OpPut, Payload: []byte("y")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMergeMissingWatermarkFails(t *testing.T) {
	out, err := Merge([][]Record{{put("a", 1, "x")}}, nil)
	if !errors.Is(err, ErrMissingWatermark) {
		t.Fatalf("err = %v, want ErrMissingWatermark", err)
	}
	if out != nil {
		t.Fatalf("out = %+v, want nil", out)
	}
}

func TestMergeUnsortedSegmentFails(t *testing.T) {
	cases := map[string][][]Record{
		"key order": {{put("b", 1, "x"), put("a", 2, "y")}},
		"seq order": {{put("a", 2, "x"), put("a", 1, "y")}},
		"second segment": {
			{put("a", 1, "x")},
			{put("b", 1, "y"), put("b", 0, "z")},
		},
	}
	for name, segs := range cases {
		out, err := Merge(segs, wm(10))
		if !errors.Is(err, ErrUnsortedSegment) {
			t.Errorf("%s: err = %v, want ErrUnsortedSegment", name, err)
		}
		if out != nil {
			t.Errorf("%s: out = %+v, want nil (no partial result)", name, out)
		}
	}
}

func TestMergeDuplicateSamePayloadKeepsOne(t *testing.T) {
	got, err := Merge([][]Record{
		{put("a", 1, "x")},
		{put("a", 1, "x"), put("a", 2, "y")},
	}, wm(10))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	want := []Entry{{Key: "a", Seq: 2, Op: OpPut, Payload: []byte("y")}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMergeConflictDropsOnlyThatKey(t *testing.T) {
	got, err := Merge([][]Record{
		{put("a", 1, "x"), put("b", 1, "keep")},
		{put("a", 1, "different")},
	}, wm(10))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	want := []Entry{{Key: "b", Seq: 1, Op: OpPut, Payload: []byte("keep")}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMergeSeqGapPausesOnlyThatKey(t *testing.T) {
	got, err := Merge([][]Record{
		{put("a", 1, "x"), put("a", 3, "z"), put("b", 5, "ok")},
	}, wm(10))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	want := []Entry{{Key: "b", Seq: 5, Op: OpPut, Payload: []byte("ok")}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMergeDeleteAtOrBelowWatermarkRemovesKey(t *testing.T) {
	got, err := Merge([][]Record{
		{put("a", 1, "x"), del("a", 2)},
	}, wm(2))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %+v, want empty output", got)
	}
}

func TestMergeDeleteBeyondWatermarkStaysAsTombstone(t *testing.T) {
	got, err := Merge([][]Record{
		{put("a", 1, "x"), del("a", 2)},
	}, wm(1))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	want := []Entry{{Key: "a", Seq: 2, Op: OpDelete, Payload: nil}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMergePutAfterDeleteRevivesKey(t *testing.T) {
	got, err := Merge([][]Record{
		{put("a", 1, "x"), del("a", 2)},
		{put("a", 3, "new")},
	}, wm(10))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	want := []Entry{{Key: "a", Seq: 3, Op: OpPut, Payload: []byte("new")}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMergeEmptyInput(t *testing.T) {
	got, err := Merge(nil, wm(0))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %+v, want empty output", got)
	}
}

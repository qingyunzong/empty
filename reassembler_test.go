package dataeng_test

import (
	"strings"
	"testing"
	"time"

	dataeng "example.org/dataeng/q0094"
)

func TestParseLine(t *testing.T) {
	rec, err := dataeng.ParseLine("2024-01-02T03:04:05.123456789Z stdout P hello world")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Stream != "stdout" || rec.Tag != "P" || !rec.Partial {
		t.Fatalf("unexpected record: %+v", rec)
	}
	if rec.Content != "hello world" {
		t.Fatalf("content = %q", rec.Content)
	}
	indented, err := dataeng.ParseLine("2024-01-02T03:04:05Z stdout F  indented")
	if err != nil {
		t.Fatal(err)
	}
	if indented.Content != " indented" {
		t.Fatalf("leading space lost: %q", indented.Content)
	}
	if _, err := dataeng.ParseLine("not a cri line"); err == nil {
		t.Fatal("expected an error")
	}
}

func TestReassemblePartialAndFull(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler()

	if got := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "hel"}); len(got) != 0 {
		t.Fatalf("unexpected output: %+v", got)
	}
	if got := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "lo "}); len(got) != 0 {
		t.Fatalf("unexpected output: %+v", got)
	}
	got := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Content: "world"})
	if len(got) != 1 {
		t.Fatalf("got %d records", len(got))
	}
	if got[0].Content != "hello world" || got[0].Tag != "F" || got[0].Truncated {
		t.Fatalf("unexpected output: %+v", got[0])
	}
}

func TestStreamsAtSameTimestampAreIndependent(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler()
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "out-"})
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stderr", Tag: "P", Content: "err-"})

	out := r.Add(dataeng.Record{Timestamp: ts, Stream: "stderr", Tag: "F", Content: "2"})
	if len(out) != 1 || out[0].Stream != "stderr" || out[0].Content != "err-2" {
		t.Fatalf("stderr output = %+v", out)
	}
	out = r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Content: "1"})
	if len(out) != 1 || out[0].Stream != "stdout" || out[0].Content != "out-1" {
		t.Fatalf("stdout output = %+v", out)
	}
}

func TestSourceTagsAreIndependent(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler()
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Source: "a", Content: "a-"})
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Source: "b", Content: "b-"})

	out := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Source: "a", Content: "1"})
	if len(out) != 1 || out[0].Content != "a-1" {
		t.Fatalf("source a output = %+v", out)
	}
	out = r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Source: "b", Content: "2"})
	if len(out) != 1 || out[0].Content != "b-2" {
		t.Fatalf("source b output = %+v", out)
	}
}

func TestDifferentTimestampsDoNotJoin(t *testing.T) {
	t1 := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	t2 := t1.Add(time.Nanosecond)
	r := dataeng.NewReassembler()
	r.Add(dataeng.Record{Timestamp: t1, Stream: "stdout", Tag: "P", Content: "first"})

	out := r.Add(dataeng.Record{Timestamp: t2, Stream: "stdout", Tag: "F", Content: "second"})
	if len(out) != 1 || out[0].Content != "second" {
		t.Fatalf("output = %+v", out)
	}
	out = r.Flush()
	if len(out) != 1 || out[0].Content != "first"+dataeng.TruncationMarker || !out[0].Truncated {
		t.Fatalf("flush output = %+v", out)
	}
}

func TestRotationDoesNotJoinGenerations(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler()
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Generation: 1, Content: "old-"})

	out := r.Rotate()
	if len(out) != 1 || out[0].Content != "old-"+dataeng.TruncationMarker || !out[0].Truncated {
		t.Fatalf("rotation output = %+v", out)
	}

	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Generation: 2, Content: "new-"})
	out = r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Generation: 2, Content: "record"})
	if len(out) != 1 || out[0].Content != "new-record" || out[0].Truncated {
		t.Fatalf("new generation output = %+v", out)
	}
}

func TestGenerationChangeFlushesOldPartials(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler()
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Generation: 10, Content: "old"})

	out := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Generation: 11, Content: "new"})
	if len(out) != 2 {
		t.Fatalf("got %d records: %+v", len(out), out)
	}
	if out[0].Content != "old"+dataeng.TruncationMarker || !out[0].Truncated {
		t.Fatalf("old output = %+v", out[0])
	}
	if out[1].Content != "new" || out[1].Truncated {
		t.Fatalf("new output = %+v", out[1])
	}
}

func TestRotationWithoutExplicitGeneration(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler()
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "old-"})

	out := r.Rotate()
	if len(out) != 1 || !out[0].Truncated {
		t.Fatalf("rotation output = %+v", out)
	}

	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "new-"})
	out = r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Content: "record"})
	if len(out) != 1 || out[0].Content != "new-record" {
		t.Fatalf("new file output = %+v", out)
	}
}

func TestMissingFinalFragmentIsTruncated(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler()
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "unfinished"})

	out := r.Flush()
	if len(out) != 1 || !out[0].Truncated {
		t.Fatalf("flush output = %+v", out)
	}
	if out[0].Content != "unfinished"+dataeng.TruncationMarker {
		t.Fatalf("content = %q", out[0].Content)
	}
}

func TestByteLimitEmitsOneTruncatedRecord(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler(dataeng.WithMaxBytes(5))
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "abc"})

	out := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Content: "def"})
	if len(out) != 1 || !out[0].Truncated {
		t.Fatalf("output = %+v", out)
	}
	if out[0].Content != "abcde"+dataeng.TruncationMarker {
		t.Fatalf("content = %q", out[0].Content)
	}
	if extra := r.Flush(); len(extra) != 0 {
		t.Fatalf("unexpected flush output: %+v", extra)
	}
}

func TestByteLimitOnSinglePartialFragment(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler(dataeng.WithMaxBytes(4))
	out := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "abcdef"})
	if len(out) != 1 || !out[0].Truncated || out[0].Content != "abcd"+dataeng.TruncationMarker {
		t.Fatalf("output = %+v", out)
	}
	if extra := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Content: "ghi"}); len(extra) != 0 {
		t.Fatalf("final fragment produced a second record: %+v", extra)
	}
}

func TestFragmentLimitEmitsOneTruncatedRecord(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	r := dataeng.NewReassembler(dataeng.WithMaxFragments(2))
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "a"})
	r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "b"})

	out := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "P", Content: "c"})
	if len(out) != 1 || !out[0].Truncated || out[0].Content != "ab"+dataeng.TruncationMarker {
		t.Fatalf("output = %+v", out)
	}
	if extra := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Content: "d"}); len(extra) != 0 {
		t.Fatalf("unexpected output for final fragment: %+v", extra)
	}
}

func TestSingleFullRecordRespectsByteLimit(t *testing.T) {
	r := dataeng.NewReassembler(dataeng.WithMaxBytes(4))
	out := r.Add(dataeng.Record{
		Timestamp: "2024-01-02T03:04:05Z",
		Stream:    "stdout",
		Tag:       "F",
		Content:   "abcdef",
	})
	if len(out) != 1 || !out[0].Truncated || out[0].Content != "abcd"+dataeng.TruncationMarker {
		t.Fatalf("output = %+v", out)
	}
}

func TestBatchLines(t *testing.T) {
	lines := []string{
		"2024-01-02T03:04:05Z stdout P hello ",
		"2024-01-02T03:04:05Z stdout F world",
		"2024-01-02T03:04:05Z stderr F separate",
		"2024-01-02T03:04:06Z stdout P dangling",
	}
	out := dataeng.ReassembleLines(lines)
	if len(out) != 3 {
		t.Fatalf("got %d records: %+v", len(out), out)
	}
	if out[0].Content != "hello world" || out[0].Stream != "stdout" {
		t.Fatalf("first output = %+v", out[0])
	}
	if out[1].Content != "separate" || out[1].Stream != "stderr" {
		t.Fatalf("second output = %+v", out[1])
	}
	if out[2].Content != "dangling"+dataeng.TruncationMarker || !out[2].Truncated {
		t.Fatalf("third output = %+v", out[2])
	}
}

func TestCustomRecordShape(t *testing.T) {
	type entry struct {
		Timestamp  string
		Stream     string
		Tag        string
		Content    string
		Generation int
	}
	r := dataeng.NewReassembler()
	r.Add(entry{"2024-01-02T03:04:05Z", "stdout", "P", "one", 1})
	out := r.Add(entry{"2024-01-02T03:04:05Z", "stdout", "F", "two", 1})
	if len(out) != 1 || out[0].Content != "onetwo" {
		t.Fatalf("output = %+v", out)
	}
}

func TestMarkerIsConfigurable(t *testing.T) {
	r := dataeng.NewReassembler(dataeng.WithTruncationMarker("<cut>"))
	r.Add(dataeng.Record{Timestamp: "2024-01-02T03:04:05Z", Stream: "stdout", Tag: "P", Content: "x"})
	out := r.Flush()
	if len(out) != 1 || !strings.HasSuffix(out[0].Content, "<cut>") {
		t.Fatalf("output = %+v", out)
	}
}

func TestConfigurationForms(t *testing.T) {
	ts := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	configs := []*dataeng.Reassembler{
		dataeng.NewReassembler(dataeng.Config{MaxBytes: 4}),
		dataeng.NewReassembler(&dataeng.Config{MaxBytes: 4}),
		dataeng.NewReassembler(dataeng.Options{MaxBytes: 4}),
		dataeng.NewReassembler(dataeng.MaxBytes(4)),
	}
	for _, r := range configs {
		out := r.Add(dataeng.Record{Timestamp: ts, Stream: "stdout", Tag: "F", Content: "abcdef"})
		if len(out) != 1 || !out[0].Truncated {
			t.Fatalf("configuration was not applied: %+v", out)
		}
	}
}

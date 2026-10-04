package logparse

import (
	"reflect"
	"strings"
	"testing"
)

func testRules() []Rule { return DefaultRules() }

type output struct {
	recs  []Record
	diags []Diagnostic
}

// run 以给定切块大小喂入输入并收集全部输出。
func run(t *testing.T, input string, maxLen int, chunks ...int) output {
	t.Helper()
	var out output
	p := NewParser(Options{Rules: testRules(), MaxLineLength: maxLen},
		func(r Record) { out.recs = append(out.recs, r) },
		func(d Diagnostic) { out.diags = append(out.diags, d) },
	)
	rest := input
	for _, c := range chunks {
		if c > len(rest) {
			c = len(rest)
		}
		p.Write([]byte(rest[:c]))
		rest = rest[c:]
	}
	if len(rest) > 0 {
		p.Write([]byte(rest))
	}
	p.Close()
	return out
}

// runAll 用多种切块方式解析同一输入，要求结果与整体喂入完全一致。
func runAll(t *testing.T, input string, maxLen int) output {
	t.Helper()
	want := run(t, input, maxLen, len(input))
	for _, size := range []int{1, 2, 3, 5, 7, 13, 64} {
		var chunks []int
		for n := len(input); n > 0; n -= size {
			chunks = append(chunks, min(size, n))
		}
		if got := run(t, input, maxLen, chunks...); !reflect.DeepEqual(got, want) {
			t.Fatalf("chunk size %d: got %+v, want %+v", size, got, want)
		}
	}
	// 固定种子的伪随机切块。
	seed := uint32(42)
	for trial := 0; trial < 20; trial++ {
		var chunks []int
		for n := len(input); n > 0; {
			seed = seed*1664525 + 1013904223
			c := int(seed%17) + 1
			if c > n {
				c = n
			}
			chunks = append(chunks, c)
			n -= c
		}
		if got := run(t, input, maxLen, chunks...); !reflect.DeepEqual(got, want) {
			t.Fatalf("random chunks %v: got %+v, want %+v", chunks, got, want)
		}
	}
	return want
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func TestStartAndContinuation(t *testing.T) {
	input := "2024-01-02 03:04:05 start\n\tat frame1\n\tat frame2\n2024-01-02 03:04:06 next\n"
	out := runAll(t, input, 0)
	if len(out.diags) != 0 {
		t.Fatalf("unexpected diags: %+v", out.diags)
	}
	if len(out.recs) != 2 {
		t.Fatalf("want 2 records, got %+v", out.recs)
	}
	r := out.recs[0]
	if r.Rule != "timestamp" || len(r.Lines) != 3 || r.Lines[1] != "\tat frame1" {
		t.Fatalf("bad record: %+v", r)
	}
	if r.Start != 0 || r.End != int64(len("2024-01-02 03:04:05 start\n\tat frame1\n\tat frame2")) {
		t.Fatalf("bad span: %d:%d", r.Start, r.End)
	}
	if out.recs[1].Start != r.End+1 {
		t.Fatalf("second record start = %d, want %d", out.recs[1].Start, r.End+1)
	}
}

func TestOrphanContinuation(t *testing.T) {
	input := "\torphan\n\tanother\n2024-01-02 03:04:05 ok\n"
	out := runAll(t, input, 0)
	if len(out.recs) != 1 || out.recs[0].Rule != "timestamp" {
		t.Fatalf("bad records: %+v", out.recs)
	}
	if len(out.diags) != 2 {
		t.Fatalf("want 2 orphan diags, got %+v", out.diags)
	}
	d := out.diags[0]
	if d.Kind != DiagOrphanContinuation || d.Start != 0 || d.End != int64(len("\torphan")) {
		t.Fatalf("bad diag: %+v", d)
	}
	if input[d.Start:d.End] != "\torphan" {
		t.Fatalf("diag range mismatch: %q", input[d.Start:d.End])
	}
}

func TestContinuationAfterPlainIsOrphan(t *testing.T) {
	input := "plain line\n\torphan\n"
	out := runAll(t, input, 0)
	if len(out.recs) != 1 || out.recs[0].Rule != "" || len(out.recs[0].Lines) != 1 {
		t.Fatalf("bad records: %+v", out.recs)
	}
	if len(out.diags) != 1 || out.diags[0].Kind != DiagOrphanContinuation {
		t.Fatalf("bad diags: %+v", out.diags)
	}
}

func TestLineTooLongDiscard(t *testing.T) {
	long := strings.Repeat("x", 50)
	input := "2024-01-02 03:04:05 keep\n" +
		"\t" + long + "\n" + // 超限续行：从此处开始丢弃
		"\talso dropped\n" +
		"plain dropped\n" +
		"2024-01-02 03:04:06 resume\n"
	out := runAll(t, input, 30)

	if len(out.recs) != 2 {
		t.Fatalf("want 2 records, got %+v", out.recs)
	}
	if out.recs[0].Lines[0] != "2024-01-02 03:04:05 keep" || len(out.recs[0].Lines) != 1 {
		t.Fatalf("first record should close before overlong line: %+v", out.recs[0])
	}
	if out.recs[1].Lines[0] != "2024-01-02 03:04:06 resume" {
		t.Fatalf("bad resume record: %+v", out.recs[1])
	}

	if len(out.diags) != 1 || out.diags[0].Kind != DiagLineTooLong {
		t.Fatalf("bad diags: %+v", out.diags)
	}
	d := out.diags[0]
	discarded := "\t" + long + "\n\talso dropped\nplain dropped\n"
	if got := input[d.Start:d.End]; got != discarded {
		t.Fatalf("discard range = %q, want %q", got, discarded)
	}
	if d.End != out.recs[1].Start {
		t.Fatalf("discard end %d should equal resume record start %d", d.End, out.recs[1].Start)
	}
}

func TestTooLongStartLineIsAlsoDiscarded(t *testing.T) {
	longStart := "2024-01-02 03:04:05 " + strings.Repeat("y", 30)
	input := longStart + "\n\tcont\n2024-01-02 03:04:06 ok\n"
	out := runAll(t, input, 30)
	if len(out.recs) != 1 || out.recs[0].Lines[0] != "2024-01-02 03:04:06 ok" {
		t.Fatalf("bad records: %+v", out.recs)
	}
	if len(out.diags) != 1 || out.diags[0].Kind != DiagLineTooLong {
		t.Fatalf("bad diags: %+v", out.diags)
	}
	if got := input[out.diags[0].Start:out.diags[0].End]; got != longStart+"\n\tcont\n" {
		t.Fatalf("bad discard range: %q", got)
	}
}

func TestDiscardUntilEOF(t *testing.T) {
	long := strings.Repeat("z", 40)
	input := "2024-01-02 03:04:05 keep\n" + long + "\n\ttail\n" + "no newline tail"
	out := runAll(t, input, 30)
	if len(out.recs) != 1 {
		t.Fatalf("bad records: %+v", out.recs)
	}
	if len(out.diags) != 1 || out.diags[0].Kind != DiagLineTooLong {
		t.Fatalf("bad diags: %+v", out.diags)
	}
	d := out.diags[0]
	if d.End != int64(len(input)) {
		t.Fatalf("discard should extend to EOF: %d:%d", d.Start, d.End)
	}
	if got := input[d.Start:d.End]; got != long+"\n\ttail\nno newline tail" {
		t.Fatalf("bad discard range: %q", got)
	}
}

func TestNoTrailingNewline(t *testing.T) {
	input := "2024-01-02 03:04:05 start\n\tcont"
	out := runAll(t, input, 0)
	if len(out.recs) != 1 || len(out.recs[0].Lines) != 2 {
		t.Fatalf("bad records: %+v", out.recs)
	}
	if out.recs[0].End != int64(len(input)) {
		t.Fatalf("record end = %d, want %d", out.recs[0].End, len(input))
	}
}

func TestEmptyAndBlankInput(t *testing.T) {
	if out := runAll(t, "", 0); len(out.recs) != 0 || len(out.diags) != 0 {
		t.Fatalf("empty input: %+v", out)
	}
	out := runAll(t, "\n\n", 0)
	if len(out.recs) != 2 || out.recs[0].Lines[0] != "" || len(out.diags) != 0 {
		t.Fatalf("blank lines should be plain records: %+v", out)
	}
}

func TestCRLF(t *testing.T) {
	input := "2024-01-02 03:04:05 a\r\n\tcont\r\nplain"
	out := runAll(t, input, 0)
	if len(out.recs) != 2 || len(out.diags) != 0 {
		t.Fatalf("bad output: %+v", out)
	}
	if out.recs[0].Lines[1] != "\tcont" {
		t.Fatalf("CR not stripped: %q", out.recs[0].Lines[1])
	}
}

func TestLevelRule(t *testing.T) {
	input := "[INFO] boot\n\tstep1\n[ERROR] boom\n"
	out := runAll(t, input, 0)
	if len(out.recs) != 2 || out.recs[0].Rule != "level" || out.recs[1].Rule != "level" {
		t.Fatalf("bad records: %+v", out.recs)
	}
	if len(out.recs[0].Lines) != 2 {
		t.Fatalf("continuation not attached: %+v", out.recs[0])
	}
}

func TestLineExactlyAtLimit(t *testing.T) {
	line := strings.Repeat("a", 20)
	input := line + "\n" + strings.Repeat("b", 21) + "\n"
	out := runAll(t, input, 20)
	if len(out.recs) != 1 || out.recs[0].Lines[0] != line {
		t.Fatalf("line at limit must be kept: %+v", out.recs)
	}
	if len(out.diags) != 1 || out.diags[0].Kind != DiagLineTooLong {
		t.Fatalf("line over limit must be discarded: %+v", out.diags)
	}
}

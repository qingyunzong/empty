package logrec_test

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"

	"logrec"
)

func run(t *testing.T, cfg logrec.Config, data []byte, chunk int) ([]logrec.Record, []logrec.Diagnostic) {
	t.Helper()
	if chunk < 1 {
		chunk = 1
	}
	p, err := logrec.New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for i := 0; i < len(data); i += chunk {
		j := i + chunk
		if j > len(data) {
			j = len(data)
		}
		p.Write(data[i:j])
	}
	p.Close()
	return p.Records(), p.Diagnostics()
}

func TestAssembleRecords(t *testing.T) {
	recs, diags := run(t, logrec.Config{}, []byte("alpha\n  beta\n  gamma\ndelta\n"), 1<<20)
	want := []logrec.Record{
		{Offset: 0, Line: 1, Lines: []string{"alpha", "  beta", "  gamma"}},
		{Offset: 21, Line: 4, Lines: []string{"delta"}},
	}
	if !reflect.DeepEqual(recs, want) {
		t.Errorf("records = %+v, want %+v", recs, want)
	}
	if len(diags) != 0 {
		t.Errorf("diags = %+v, want none", diags)
	}
}

func TestOrphanContinuation(t *testing.T) {
	recs, diags := run(t, logrec.Config{}, []byte("  stray\nstart\n"), 1<<20)
	wantRecs := []logrec.Record{{Offset: 8, Line: 2, Lines: []string{"start"}}}
	wantDiags := []logrec.Diagnostic{{Kind: logrec.DiagOrphanContinuation, Start: 0, End: 8, Line: 1}}
	if !reflect.DeepEqual(recs, wantRecs) {
		t.Errorf("records = %+v, want %+v", recs, wantRecs)
	}
	if !reflect.DeepEqual(diags, wantDiags) {
		t.Errorf("diags = %+v, want %+v", diags, wantDiags)
	}
}

func TestUnmatchedLineIsOrphanWithRules(t *testing.T) {
	cfg := logrec.Config{Rules: []logrec.Rule{{Prefix: "ERROR", Kind: logrec.Start}}}
	recs, diags := run(t, cfg, []byte("junk\nERROR boom\n"), 1<<20)
	wantRecs := []logrec.Record{{Offset: 5, Line: 2, Lines: []string{"ERROR boom"}}}
	wantDiags := []logrec.Diagnostic{{Kind: logrec.DiagOrphanContinuation, Start: 0, End: 5, Line: 1}}
	if !reflect.DeepEqual(recs, wantRecs) {
		t.Errorf("records = %+v, want %+v", recs, wantRecs)
	}
	if !reflect.DeepEqual(diags, wantDiags) {
		t.Errorf("diags = %+v, want %+v", diags, wantDiags)
	}
}

func TestOversizeDiscardUntilNextStart(t *testing.T) {
	cfg := logrec.Config{MaxLineBytes: 4}
	recs, diags := run(t, cfg, []byte("ok\ntoolongline\n cont\nnext\n"), 1<<20)
	wantRecs := []logrec.Record{
		{Offset: 0, Line: 1, Lines: []string{"ok"}},
		{Offset: 21, Line: 4, Lines: []string{"next"}},
	}
	wantDiags := []logrec.Diagnostic{{Kind: logrec.DiagOversize, Start: 3, End: 21, Line: 2}}
	if !reflect.DeepEqual(recs, wantRecs) {
		t.Errorf("records = %+v, want %+v", recs, wantRecs)
	}
	if !reflect.DeepEqual(diags, wantDiags) {
		t.Errorf("diags = %+v, want %+v", diags, wantDiags)
	}
}

func TestOversizeDiscardRunsToEOF(t *testing.T) {
	cfg := logrec.Config{MaxLineBytes: 3}
	recs, diags := run(t, cfg, []byte("aa\nbbbbbb\n  cc\n"), 1<<20)
	wantRecs := []logrec.Record{{Offset: 0, Line: 1, Lines: []string{"aa"}}}
	wantDiags := []logrec.Diagnostic{{Kind: logrec.DiagOversize, Start: 3, End: 15, Line: 2}}
	if !reflect.DeepEqual(recs, wantRecs) {
		t.Errorf("records = %+v, want %+v", recs, wantRecs)
	}
	if !reflect.DeepEqual(diags, wantDiags) {
		t.Errorf("diags = %+v, want %+v", diags, wantDiags)
	}
}

func TestOversizeLineAtLimitIsKept(t *testing.T) {
	cfg := logrec.Config{MaxLineBytes: 4}
	recs, diags := run(t, cfg, []byte("abcd\nabcde\n"), 1<<20)
	wantRecs := []logrec.Record{{Offset: 0, Line: 1, Lines: []string{"abcd"}}}
	wantDiags := []logrec.Diagnostic{{Kind: logrec.DiagOversize, Start: 5, End: 11, Line: 2}}
	if !reflect.DeepEqual(recs, wantRecs) {
		t.Errorf("records = %+v, want %+v", recs, wantRecs)
	}
	if !reflect.DeepEqual(diags, wantDiags) {
		t.Errorf("diags = %+v, want %+v", diags, wantDiags)
	}
}

func TestFinalLineWithoutNewline(t *testing.T) {
	recs, diags := run(t, logrec.Config{}, []byte("one\n  two"), 1<<20)
	want := []logrec.Record{{Offset: 0, Line: 1, Lines: []string{"one", "  two"}}}
	if !reflect.DeepEqual(recs, want) {
		t.Errorf("records = %+v, want %+v", recs, want)
	}
	if len(diags) != 0 {
		t.Errorf("diags = %+v, want none", diags)
	}
}

func TestOrphanFinalLineWithoutNewline(t *testing.T) {
	_, diags := run(t, logrec.Config{}, []byte("  orphan"), 1<<20)
	want := []logrec.Diagnostic{{Kind: logrec.DiagOrphanContinuation, Start: 0, End: 8, Line: 1}}
	if !reflect.DeepEqual(diags, want) {
		t.Errorf("diags = %+v, want %+v", diags, want)
	}
}

func TestCRLF(t *testing.T) {
	recs, diags := run(t, logrec.Config{}, []byte("a\r\n b\r\n"), 1<<20)
	want := []logrec.Record{{Offset: 0, Line: 1, Lines: []string{"a", " b"}}}
	if !reflect.DeepEqual(recs, want) {
		t.Errorf("records = %+v, want %+v", recs, want)
	}
	if len(diags) != 0 {
		t.Errorf("diags = %+v, want none", diags)
	}
}

func TestFirstMatchingRuleWins(t *testing.T) {
	cfg := logrec.Config{Rules: []logrec.Rule{
		{Prefix: ">", Kind: logrec.Continuation},
		{Prefix: ">", Kind: logrec.Start},
	}}
	recs, diags := run(t, cfg, []byte("> x\n"), 1<<20)
	if len(recs) != 0 {
		t.Errorf("records = %+v, want none", recs)
	}
	if len(diags) != 1 || diags[0].Kind != logrec.DiagOrphanContinuation {
		t.Errorf("diags = %+v, want one orphan-continuation", diags)
	}
}

func TestRuleTableIsBounded(t *testing.T) {
	rules := make([]logrec.Rule, logrec.MaxRules+1)
	if _, err := logrec.New(logrec.Config{Rules: rules}); err == nil {
		t.Error("New with MaxRules+1 rules: want error, got nil")
	}
	if _, err := logrec.New(logrec.Config{Rules: rules[:logrec.MaxRules]}); err != nil {
		t.Errorf("New with MaxRules rules: %v", err)
	}
	if _, err := logrec.New(logrec.Config{MaxLineBytes: -1}); err == nil {
		t.Error("New with negative MaxLineBytes: want error, got nil")
	}
}

func TestEmptyAndBlankInput(t *testing.T) {
	for _, in := range []string{"", "\n", "\n\n"} {
		recs, diags := run(t, logrec.Config{}, []byte(in), 1<<20)
		if len(diags) != 0 {
			t.Errorf("input %q: diags = %+v, want none", in, diags)
		}
		wantRecs := 0
		if in != "" {
			wantRecs = strings.Count(in, "\n")
		}
		if len(recs) != wantRecs {
			t.Errorf("input %q: %d records, want %d", in, len(recs), wantRecs)
		}
	}
}

// TestChunkingInvariant feeds the same inputs in every possible fixed
// chunk size and in random chunkings, and requires records and
// diagnostics to be identical to a one-shot parse.
func TestChunkingInvariant(t *testing.T) {
	cfg := logrec.Config{
		Rules: []logrec.Rule{
			{Prefix: "ERROR", Kind: logrec.Start},
			{Prefix: "WARN", Kind: logrec.Start},
			{Prefix: " ", Kind: logrec.Continuation},
			{Prefix: "\t", Kind: logrec.Continuation},
		},
		MaxLineBytes: 12,
	}
	inputs := []string{
		"",
		"\n",
		"ERROR one\n two\nERROR three\n",
		"  orphan\nERROR a\n",
		"ERROR a\nthis-line-is-way-too-long\n cont\nERROR b\n",
		"ERROR a\nthis-line-is-way-too-long\n cont\n",
		"WARN x\n\tstack\nERROR y", // no trailing newline
		"  orphan-no-newline",
		"plain\nlines\nno\nrules-matched\n",
		"ERROR\r\ncrlf\r\n",
	}
	for _, in := range inputs {
		data := []byte(in)
		wantRecs, wantDiags := run(t, cfg, data, len(data)+1)
		for chunk := 1; chunk <= len(data)+1; chunk++ {
			recs, diags := run(t, cfg, data, chunk)
			if !reflect.DeepEqual(recs, wantRecs) || !reflect.DeepEqual(diags, wantDiags) {
				t.Errorf("input %q chunk %d:\n recs = %+v, want %+v\n diags = %+v, want %+v",
					in, chunk, recs, wantRecs, diags, wantDiags)
			}
		}
		rng := rand.New(rand.NewSource(1))
		for trial := 0; trial < 20; trial++ {
			p, err := logrec.New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < len(data); {
				n := 1 + rng.Intn(7)
				if i+n > len(data) {
					n = len(data) - i
				}
				p.Write(data[i : i+n])
				i += n
			}
			p.Close()
			if !reflect.DeepEqual(p.Records(), wantRecs) || !reflect.DeepEqual(p.Diagnostics(), wantDiags) {
				t.Errorf("input %q random chunking:\n recs = %+v, want %+v\n diags = %+v, want %+v",
					in, p.Records(), wantRecs, p.Diagnostics(), wantDiags)
			}
		}
	}
}

// TestChunkingInvariantDefaultRules checks the no-rules heuristic under
// chunking as well.
func TestChunkingInvariantDefaultRules(t *testing.T) {
	cfg := logrec.Config{MaxLineBytes: 8}
	in := "head\n cont\nway-too-long-line\n\tmore\ntail"
	data := []byte(in)
	wantRecs, wantDiags := run(t, cfg, data, len(data)+1)
	for chunk := 1; chunk <= len(data)+1; chunk++ {
		recs, diags := run(t, cfg, data, chunk)
		if !reflect.DeepEqual(recs, wantRecs) || !reflect.DeepEqual(diags, wantDiags) {
			t.Errorf("chunk %d:\n recs = %+v, want %+v\n diags = %+v, want %+v",
				chunk, recs, wantRecs, diags, wantDiags)
		}
	}
}

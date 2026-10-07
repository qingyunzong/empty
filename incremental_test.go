package effectcheck

import (
	"fmt"
	"sort"
	"strings"
	"testing"
)

// resultString renders a Result deterministically for comparison.
func resultString(res *Result) string {
	var b strings.Builder
	names := make([]string, 0, len(res.Effects))
	for n := range res.Effects {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(&b, "%s: %s\n", n, res.Effects[n])
	}
	for _, d := range res.Diagnostics {
		fmt.Fprintln(&b, d)
	}
	return b.String()
}

// replaceFunc splices a new function definition (full text, header
// included) over the same-named function in src.
func replaceFunc(t *testing.T, src, newFn string) string {
	t.Helper()
	header := strings.SplitN(newFn, "\n", 2)[0]
	name := strings.TrimPrefix(strings.SplitN(header, "(", 2)[0], "fn ")
	lines := strings.Split(strings.TrimRight(src, "\n"), "\n")
	start := -1
	for i, l := range lines {
		if strings.HasPrefix(l, "fn "+name+"(") {
			start = i
			break
		}
	}
	if start < 0 {
		t.Fatalf("function %s not found in source", name)
	}
	end := start + 1
	for end < len(lines) && (strings.HasPrefix(lines[end], " ") || strings.HasPrefix(lines[end], "\t")) {
		end++
	}
	var out []string
	out = append(out, lines[:start]...)
	out = append(out, strings.Split(strings.TrimRight(newFn, "\n"), "\n")...)
	out = append(out, lines[end:]...)
	return strings.Join(out, "\n") + "\n"
}

const incBase = `global g
global h

fn leaf():
    read g

fn mid():
    call leaf()
    write h

fn top():
    call mid()

fn spin():
    read h
    call spin()

fn iso():
    region tmp
    read tmp
`

func TestIncrementalMatchesFull(t *testing.T) {
	mutations := []struct{ name, newFn string }{
		// Change direct effects and add an exception.
		{"leaf", "fn leaf():\n    read h\n    throw IO\n"},
		// Drop a write; callers must lose the effect too.
		{"mid", "fn mid():\n    call leaf()\n"},
		// Redirect a call into a recursive cycle.
		{"top", "fn top():\n    call spin()\n"},
		// Introduce a local-region escape.
		{"iso", "fn iso():\n    region tmp\n    return tmp\n"},
		// Break the self-recursion, turning spin into a plain caller.
		{"spin", "fn spin():\n    call mid()\n    read h\n"},
		// Fix the escape again.
		{"iso", "fn iso():\n    region tmp\n    read tmp\n"},
	}

	cur := incBase
	inc := NewIncremental(mustParse(t, "test.fx", cur))
	if got, want := resultString(inc.Result()), resultString(analyzeSource(t, cur)); got != want {
		t.Fatalf("initial:\nincremental:\n%s\nfull:\n%s", got, want)
	}
	for i, m := range mutations {
		cur = replaceFunc(t, cur, m.newFn)
		newProg := mustParse(t, "test.fx", cur)
		if err := inc.ReplaceFunc(newProg.Func(m.name)); err != nil {
			t.Fatalf("mutation %d: %v", i, err)
		}
		got := resultString(inc.Result())
		want := resultString(Analyze(newProg))
		if got != want {
			t.Errorf("after mutation %d (%s):\nincremental:\n%s\nfull:\n%s", i, m.name, got, want)
		}
	}
}

func TestIncrementalSkipsUnaffected(t *testing.T) {
	inc := NewIncremental(mustParse(t, "test.fx", incBase))

	cur := replaceFunc(t, incBase, "fn leaf():\n    read h\n")
	if err := inc.ReplaceFunc(mustParse(t, "test.fx", cur).Func("leaf")); err != nil {
		t.Fatal(err)
	}
	rec := inc.Recomputed()
	for _, want := range []string{"leaf", "mid", "top"} {
		if rec[want] == 0 {
			t.Errorf("expected %s to be recomputed, recomputed = %v", want, rec)
		}
	}
	for _, skip := range []string{"spin", "iso"} {
		if rec[skip] != 0 {
			t.Errorf("expected %s to be skipped, recomputed = %v", skip, rec)
		}
	}
}

func TestIncrementalStopsWhenEffectsUnchanged(t *testing.T) {
	inc := NewIncremental(mustParse(t, "test.fx", incBase))

	// Rewrite mid with a body whose published effects are identical:
	// the extra write targets a local region and is masked.
	cur := replaceFunc(t, incBase, "fn mid():\n    region tmp\n    call leaf()\n    write tmp\n    write h\n")
	if err := inc.ReplaceFunc(mustParse(t, "test.fx", cur).Func("mid")); err != nil {
		t.Fatal(err)
	}
	rec := inc.Recomputed()
	if rec["mid"] == 0 {
		t.Errorf("mid should be recomputed, recomputed = %v", rec)
	}
	if rec["top"] != 0 {
		t.Errorf("top's inputs did not change; it should be skipped, recomputed = %v", rec)
	}
	if got, want := resultString(inc.Result()), resultString(analyzeSource(t, cur)); got != want {
		t.Errorf("incremental:\n%s\nfull:\n%s", got, want)
	}
}

func TestIncrementalCycleUpdate(t *testing.T) {
	base := `global a
global b

fn ping():
    read a
    call pong()

fn pong():
    write b
    call ping()

fn entry():
    call ping()
`
	inc := NewIncremental(mustParse(t, "c.fx", base))
	cur := replaceFunc(t, base, "fn pong():\n    write b\n    throw Boom\n    call ping()\n")
	newProg := mustParse(t, "c.fx", cur)
	if err := inc.ReplaceFunc(newProg.Func("pong")); err != nil {
		t.Fatal(err)
	}
	if got, want := resultString(inc.Result()), resultString(Analyze(newProg)); got != want {
		t.Errorf("incremental:\n%s\nfull:\n%s", got, want)
	}
	wantEffects(t, inc.Result(), "entry", "reads{a} writes{b} throws{Boom}")
}

func TestReplaceFuncErrors(t *testing.T) {
	inc := NewIncremental(mustParse(t, "test.fx", "fn f(a):\n    read a\n"))
	if err := inc.ReplaceFunc(&Func{Name: "ghost"}); err == nil {
		t.Error("expected error for unknown function")
	}
	if err := inc.ReplaceFunc(&Func{Name: "f", Params: []string{"a", "b"}}); err == nil {
		t.Error("expected error for signature change")
	}
}

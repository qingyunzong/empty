package effectcheck

import "testing"

// chainProgram builds: main -> a -> c, main -> b.
func chainProgram() *Program {
	return NewProgram(
		&Func{
			Name:   "main",
			Locals: locals("tmp"),
			Body: []Stmt{
				write("tmp", "src/main.ef:2"),
				call("a", "src/main.ef:3"),
				call("b", "src/main.ef:4"),
			},
		},
		&Func{
			Name: "a",
			Body: []Stmt{
				read("x", "src/a.ef:1"),
				call("c", "src/a.ef:2"),
			},
		},
		&Func{
			Name: "b",
			Body: []Stmt{
				write("y", "src/b.ef:1"),
				throw("E1", "src/b.ef:2"),
			},
		},
		&Func{
			Name: "c",
			Body: []Stmt{
				read("z", "src/c.ef:1"),
				write("w", "src/c.ef:2"),
			},
		},
	)
}

func checkIncremental(t *testing.T, a *Analyzer) {
	t.Helper()
	inc := a.Result()
	full := Analyze(a.Program())
	if !inc.Equal(full) {
		for name, s := range full.Summaries {
			if is := inc.Summaries[name]; !s.equal(is) {
				t.Errorf("function %s:\n  incremental reads=%v writes=%v throws=%v\n  full        reads=%v writes=%v throws=%v",
					name,
					SortedEffects(is.Reads), SortedEffects(is.Writes), SortedThrows(is.Throws),
					SortedEffects(s.Reads), SortedEffects(s.Writes), SortedThrows(s.Throws))
			}
		}
		if len(inc.Diagnostics) != len(full.Diagnostics) {
			t.Errorf("diagnostics differ: incremental=%v full=%v", inc.Diagnostics, full.Diagnostics)
		}
	}
}

func TestIncrementalAddEffectsMatchesFull(t *testing.T) {
	a := NewAnalyzer(chainProgram())
	// Change b's body: add a read and a call to c.
	a.UpdateFunc(&Func{
		Name: "b",
		Body: []Stmt{
			write("y", "src/b.ef:1"),
			read("extra", "src/b.ef:3"),
			call("c", "src/b.ef:4"),
		},
	})
	checkIncremental(t, a)

	main := a.Result().Summaries["main"]
	if !hasRead(main, "extra", "src/b.ef:3") || !hasRead(main, "z", "src/c.ef:1") {
		t.Errorf("main did not absorb new transitive effects: reads=%v", SortedEffects(main.Reads))
	}
}

func TestIncrementalRemoveEffectsMatchesFull(t *testing.T) {
	a := NewAnalyzer(chainProgram())
	// Shrink c to an empty body: w/z effects must disappear from a and main.
	a.UpdateFunc(&Func{Name: "c"})
	checkIncremental(t, a)

	main := a.Result().Summaries["main"]
	if hasRead(main, "z", "src/c.ef:1") || hasWrite(main, "w", "src/c.ef:2") {
		t.Errorf("stale effects survived removal: reads=%v writes=%v",
			SortedEffects(main.Reads), SortedEffects(main.Writes))
	}
}

func TestIncrementalSequenceMatchesFull(t *testing.T) {
	a := NewAnalyzer(chainProgram())
	updates := []*Func{
		{Name: "c", Body: []Stmt{throw("E2", "src/c.ef:5")}},
		{Name: "a", Body: []Stmt{call("b", "src/a.ef:9")}},
		{Name: "main", Locals: locals("tmp"), Body: []Stmt{
			write("tmp", "src/main.ef:2"),
			call("a", "src/main.ef:3"),
		}},
		{Name: "b", Body: []Stmt{}},
	}
	for i, u := range updates {
		a.UpdateFunc(u)
		checkIncremental(t, a)
		_ = i
	}
}

func TestLoopCallsAccepted(t *testing.T) {
	// f -> g -> h -> f: a call cycle must be accepted and analyzed.
	p := NewProgram(
		&Func{Name: "f", Body: []Stmt{
			read("rf", "src/f.ef:1"),
			call("g", "src/f.ef:2"),
		}},
		&Func{Name: "g", Body: []Stmt{
			write("wg", "src/g.ef:1"),
			call("h", "src/g.ef:2"),
		}},
		&Func{Name: "h", Body: []Stmt{
			throw("EH", "src/h.ef:1"),
			call("f", "src/h.ef:2"),
		}},
	)
	res := Analyze(p)
	if len(res.Diagnostics) != 0 {
		t.Fatalf("call cycle rejected: %v", res.Diagnostics)
	}
	for _, name := range []string{"f", "g", "h"} {
		s := res.Summaries[name]
		if !hasRead(s, "rf", "src/f.ef:1") ||
			!hasWrite(s, "wg", "src/g.ef:1") ||
			!hasThrow(s, "EH", "src/h.ef:1") {
			t.Errorf("%s: effects did not flow around the cycle: reads=%v writes=%v throws=%v",
				name, SortedEffects(s.Reads), SortedEffects(s.Writes), SortedThrows(s.Throws))
		}
	}
}

func TestIncrementalUpdateInsideCycleMatchesFull(t *testing.T) {
	p := NewProgram(
		&Func{Name: "f", Body: []Stmt{
			read("rf", "src/f.ef:1"),
			call("g", "src/f.ef:2"),
		}},
		&Func{Name: "g", Body: []Stmt{
			write("wg", "src/g.ef:1"),
			call("h", "src/g.ef:2"),
		}},
		&Func{Name: "h", Body: []Stmt{
			throw("EH", "src/h.ef:1"),
			call("f", "src/h.ef:2"),
		}},
	)
	a := NewAnalyzer(p)
	// Add an effect inside the cycle; it must reach every function in it.
	a.UpdateFunc(&Func{Name: "h", Body: []Stmt{
		throw("EH", "src/h.ef:1"),
		read("rh", "src/h.ef:3"),
		call("f", "src/h.ef:2"),
	}})
	checkIncremental(t, a)
	for _, name := range []string{"f", "g", "h"} {
		if !hasRead(a.Result().Summaries[name], "rh", "src/h.ef:3") {
			t.Errorf("%s: new effect did not propagate around the cycle", name)
		}
	}
	// Break the cycle; effects of f must no longer reach h.
	a.UpdateFunc(&Func{Name: "h", Body: []Stmt{
		throw("EH", "src/h.ef:1"),
		read("rh", "src/h.ef:3"),
	}})
	checkIncremental(t, a)
	if hasRead(a.Result().Summaries["h"], "rf", "src/f.ef:1") {
		t.Errorf("stale effect survived cycle break")
	}
}

func TestIncrementalEscapeDiagnosticAppears(t *testing.T) {
	a := NewAnalyzer(chainProgram())
	a.UpdateFunc(&Func{
		Name:   "c",
		Locals: locals("buf"),
		Body: []Stmt{
			write("buf", "src/c.ef:1"),
			ret("buf", "src/c.ef:2"),
		},
	})
	checkIncremental(t, a)
	diags := a.Result().Diagnostics
	if len(diags) != 1 || diags[0].Func != "c" || diags[0].Region != "buf" {
		t.Fatalf("want escape diagnostic for c/buf, got %v", diags)
	}
}

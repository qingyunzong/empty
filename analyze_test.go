package effectcheck

import "testing"

func read(region, path string) Stmt  { return Stmt{Kind: ReadStmt, Region: region, Path: path} }
func write(region, path string) Stmt { return Stmt{Kind: WriteStmt, Region: region, Path: path} }
func call(target, path string) Stmt  { return Stmt{Kind: CallStmt, Target: target, Path: path} }
func throw(exc, path string) Stmt    { return Stmt{Kind: ThrowStmt, Exc: exc, Path: path} }
func ret(region, path string) Stmt   { return Stmt{Kind: ReturnStmt, Region: region, Path: path} }
func locals(names ...string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

func hasRead(s *Summary, region, path string) bool {
	_, ok := s.Reads[Effect{Region: region, Path: path}]
	return ok
}

func hasWrite(s *Summary, region, path string) bool {
	_, ok := s.Writes[Effect{Region: region, Path: path}]
	return ok
}

func hasThrow(s *Summary, exc, path string) bool {
	_, ok := s.Throws[Throw{Exc: exc, Path: path}]
	return ok
}

func TestBasicEffectsWithSourcePaths(t *testing.T) {
	p := NewProgram(&Func{
		Name: "main",
		Body: []Stmt{
			read("in", "src/main.ef:3"),
			write("out", "src/main.ef:4"),
			throw("IOError", "src/main.ef:6"),
		},
	})
	res := Analyze(p)
	s := res.Summaries["main"]
	if !hasRead(s, "in", "src/main.ef:3") {
		t.Errorf("missing read effect with source path, got %v", SortedEffects(s.Reads))
	}
	if !hasWrite(s, "out", "src/main.ef:4") {
		t.Errorf("missing write effect with source path, got %v", SortedEffects(s.Writes))
	}
	if !hasThrow(s, "IOError", "src/main.ef:6") {
		t.Errorf("missing throw effect with source path, got %v", SortedThrows(s.Throws))
	}
	if len(res.Diagnostics) != 0 {
		t.Errorf("unexpected diagnostics: %v", res.Diagnostics)
	}
}

func TestCallPropagationAndLocalHiding(t *testing.T) {
	p := NewProgram(
		&Func{
			Name: "main",
			Body: []Stmt{call("helper", "src/main.ef:2")},
		},
		&Func{
			Name:   "helper",
			Locals: locals("scratch"),
			Body: []Stmt{
				read("shared", "src/helper.ef:4"),
				write("scratch", "src/helper.ef:5"), // local: must not leak to caller
				throw("Boom", "src/helper.ef:6"),
			},
		},
	)
	res := Analyze(p)
	main := res.Summaries["main"]
	if !hasRead(main, "shared", "src/helper.ef:4") {
		t.Errorf("callee read did not propagate to caller: %v", SortedEffects(main.Reads))
	}
	if hasWrite(main, "scratch", "src/helper.ef:5") {
		t.Errorf("callee-local region leaked into caller: %v", SortedEffects(main.Writes))
	}
	if !hasThrow(main, "Boom", "src/helper.ef:6") {
		t.Errorf("callee exception did not propagate to caller: %v", SortedThrows(main.Throws))
	}
	helper := res.Summaries["helper"]
	if !hasWrite(helper, "scratch", "src/helper.ef:5") {
		t.Errorf("helper lost its own local write: %v", SortedEffects(helper.Writes))
	}
}

func TestSelfRecursionLeastFixedPoint(t *testing.T) {
	// loop(n) { read xs; if n > 0 { write acc; loop(n-1) } }
	p := NewProgram(&Func{
		Name: "loop",
		Body: []Stmt{
			read("xs", "src/loop.ef:2"),
			write("acc", "src/loop.ef:4"),
			call("loop", "src/loop.ef:5"),
		},
	})
	res := Analyze(p)
	s := res.Summaries["loop"]
	if !hasRead(s, "xs", "src/loop.ef:2") || !hasWrite(s, "acc", "src/loop.ef:4") {
		t.Errorf("recursive summary missing effects: reads=%v writes=%v",
			SortedEffects(s.Reads), SortedEffects(s.Writes))
	}
	if len(res.Diagnostics) != 0 {
		t.Errorf("unexpected diagnostics: %v", res.Diagnostics)
	}
}

func TestMutualRecursionLeastFixedPoint(t *testing.T) {
	// even -> odd -> even; effects must flow around the whole cycle.
	p := NewProgram(
		&Func{
			Name: "even",
			Body: []Stmt{
				read("n", "src/even.ef:1"),
				call("odd", "src/even.ef:3"),
			},
		},
		&Func{
			Name: "odd",
			Body: []Stmt{
				write("flag", "src/odd.ef:2"),
				call("even", "src/odd.ef:4"),
			},
		},
	)
	res := Analyze(p)
	for _, name := range []string{"even", "odd"} {
		s := res.Summaries[name]
		if !hasRead(s, "n", "src/even.ef:1") {
			t.Errorf("%s: missing read from cycle: %v", name, SortedEffects(s.Reads))
		}
		if !hasWrite(s, "flag", "src/odd.ef:2") {
			t.Errorf("%s: missing write from cycle: %v", name, SortedEffects(s.Writes))
		}
	}
}

func TestLocalRegionEscapeViaReturn(t *testing.T) {
	p := NewProgram(
		&Func{
			Name:   "bad",
			Locals: locals("buf"),
			Body: []Stmt{
				write("buf", "src/bad.ef:2"),
				ret("buf", "src/bad.ef:3"),
			},
		},
		&Func{
			Name: "good",
			Body: []Stmt{
				read("param", "src/good.ef:1"),
				ret("param", "src/good.ef:2"),
			},
		},
	)
	res := Analyze(p)
	if len(res.Diagnostics) != 1 {
		t.Fatalf("want 1 diagnostic, got %v", res.Diagnostics)
	}
	d := res.Diagnostics[0]
	if d.Func != "bad" || d.Region != "buf" {
		t.Errorf("unexpected diagnostic: %+v", d)
	}
}

func TestUnknownCalleeDiagnostic(t *testing.T) {
	p := NewProgram(&Func{
		Name: "main",
		Body: []Stmt{call("missing", "src/main.ef:9")},
	})
	res := Analyze(p)
	if len(res.Diagnostics) != 1 || res.Diagnostics[0].Func != "main" {
		t.Fatalf("want unknown-callee diagnostic, got %v", res.Diagnostics)
	}
}

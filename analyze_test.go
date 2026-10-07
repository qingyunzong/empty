package effectcheck

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, file, src string) *Program {
	t.Helper()
	p, err := Parse(file, src)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return p
}

func analyzeSource(t *testing.T, src string) *Result {
	t.Helper()
	return Analyze(mustParse(t, "test.fx", src))
}

func wantEffects(t *testing.T, res *Result, fn, want string) {
	t.Helper()
	eff, ok := res.Effects[fn]
	if !ok {
		t.Fatalf("no effects for %s", fn)
	}
	if got := eff.String(); got != want {
		t.Errorf("%s effects = %s, want %s", fn, got, want)
	}
}

func wantNoDiagnostics(t *testing.T, res *Result) {
	t.Helper()
	if len(res.Diagnostics) != 0 {
		t.Errorf("unexpected diagnostics: %v", res.Diagnostics)
	}
}

func TestBasicPropagation(t *testing.T) {
	res := analyzeSource(t, `global g

fn reader():
    read g

fn f():
    call reader()
    write g
`)
	wantEffects(t, res, "reader", "reads{g} writes{} throws{}")
	wantEffects(t, res, "f", "reads{g} writes{g} throws{}")
	wantNoDiagnostics(t, res)
}

func TestParamSubstitution(t *testing.T) {
	res := analyzeSource(t, `global g
global h

fn touch(a, b):
    read a
    write b

fn f():
    region tmp
    call touch(g, tmp)

fn g2():
    call touch(h, g)
`)
	// tmp is local to f, so the write to it is masked.
	wantEffects(t, res, "f", "reads{g} writes{} throws{}")
	wantEffects(t, res, "g2", "reads{h} writes{g} throws{}")
	wantNoDiagnostics(t, res)
}

func TestThrowPropagation(t *testing.T) {
	res := analyzeSource(t, `fn fail():
    throw IOError

fn f():
    call fail()

fn g():
    call f()
`)
	wantEffects(t, res, "g", "reads{} writes{} throws{IOError}")
	wantNoDiagnostics(t, res)
}

func TestSelfRecursionLeastFixedPoint(t *testing.T) {
	res := analyzeSource(t, `global g
global h

fn loop():
    read g
    call loop()
    write h
`)
	wantEffects(t, res, "loop", "reads{g} writes{h} throws{}")
	wantNoDiagnostics(t, res)
}

func TestMutualRecursionCycle(t *testing.T) {
	res := analyzeSource(t, `global a
global b

fn even():
    read a
    call odd()

fn odd():
    write b
    call even()
`)
	wantEffects(t, res, "even", "reads{a} writes{b} throws{}")
	wantEffects(t, res, "odd", "reads{a} writes{b} throws{}")
	wantNoDiagnostics(t, res)
}

func TestLongerCycle(t *testing.T) {
	res := analyzeSource(t, `global a
global b
global c

fn f():
    read a
    call g()

fn g():
    write b
    call h()

fn h():
    throw E
    call f()

fn unrelated():
    read c
`)
	cyclic := "reads{a} writes{b} throws{E}"
	wantEffects(t, res, "f", cyclic)
	wantEffects(t, res, "g", cyclic)
	wantEffects(t, res, "h", cyclic)
	wantEffects(t, res, "unrelated", "reads{c} writes{} throws{}")
	wantNoDiagnostics(t, res)
}

func TestLocalRegionEscapeReported(t *testing.T) {
	res := Analyze(mustParse(t, "src/bad.fx", "fn bad():\n    region tmp\n    read tmp\n    return tmp\n"))
	if len(res.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %v, want exactly 1", res.Diagnostics)
	}
	d := res.Diagnostics[0]
	if !strings.Contains(d.Msg, `local region "tmp" escapes function "bad" via return`) {
		t.Errorf("unexpected message: %s", d.Msg)
	}
	if d.P.File != "src/bad.fx" || d.P.Line != 4 || d.P.Col != 5 {
		t.Errorf("position = %s, want src/bad.fx:4:5", d.P)
	}
	if got := d.String(); got != `src/bad.fx:4:5: local region "tmp" escapes function "bad" via return` {
		t.Errorf("diagnostic = %q", got)
	}
}

func TestParamReturnIsNotEscape(t *testing.T) {
	res := analyzeSource(t, `fn id(a):
    return a
`)
	wantNoDiagnostics(t, res)
}

func TestLocalEffectsMasked(t *testing.T) {
	res := analyzeSource(t, `fn f():
    region tmp
    read tmp
    write tmp
`)
	wantEffects(t, res, "f", "reads{} writes{} throws{}")
	wantNoDiagnostics(t, res)
}

func TestUnknownCalleeDiagnostic(t *testing.T) {
	res := Analyze(mustParse(t, "u.fx", "fn f():\n    call missing()\n"))
	if len(res.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %v, want exactly 1", res.Diagnostics)
	}
	d := res.Diagnostics[0]
	if !strings.Contains(d.Msg, `unknown function "missing"`) {
		t.Errorf("unexpected message: %s", d.Msg)
	}
	if d.P.String() != "u.fx:2:5" {
		t.Errorf("position = %s, want u.fx:2:5", d.P)
	}
}

func TestUnknownRegionDiagnostic(t *testing.T) {
	res := Analyze(mustParse(t, "u.fx", "fn f():\n    read nowhere\n"))
	if len(res.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %v, want exactly 1", res.Diagnostics)
	}
	if !strings.Contains(res.Diagnostics[0].Msg, `unknown region "nowhere"`) {
		t.Errorf("unexpected message: %s", res.Diagnostics[0].Msg)
	}
}

func TestArityMismatchDiagnostic(t *testing.T) {
	res := analyzeSource(t, `fn one(a):
    read a

fn f():
    call one()
`)
	if len(res.Diagnostics) != 1 || !strings.Contains(res.Diagnostics[0].Msg, "takes 1 args, got 0") {
		t.Fatalf("diagnostics = %v", res.Diagnostics)
	}
}

func TestDiamondCalls(t *testing.T) {
	res := analyzeSource(t, `global g

fn base():
    write g

fn left():
    call base()

fn right():
    call base()

fn top():
    call left()
    call right()
`)
	wantEffects(t, res, "top", "reads{} writes{g} throws{}")
	wantNoDiagnostics(t, res)
}

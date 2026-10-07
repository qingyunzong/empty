package effectcheck

import "testing"

func TestParsePositions(t *testing.T) {
	prog := mustParse(t, "p.fx", "global g, h\n\nfn f(a, b):\n    read g\n    call g2(a)\n")
	if len(prog.Globals) != 2 || prog.Globals[0] != "g" || prog.Globals[1] != "h" {
		t.Fatalf("globals = %v", prog.Globals)
	}
	f := prog.Func("f")
	if f == nil || len(f.Params) != 2 || f.P.Line != 3 {
		t.Fatalf("fn f = %+v", f)
	}
	rd, ok := f.Body[0].(*ReadStmt)
	if !ok {
		t.Fatalf("body[0] = %T", f.Body[0])
	}
	if rd.Region != "g" || rd.P.File != "p.fx" || rd.P.Line != 4 || rd.P.Col != 5 {
		t.Errorf("read pos = %s", rd.P)
	}
	call, ok := f.Body[1].(*CallStmt)
	if !ok || call.Callee != "g2" || len(call.Args) != 1 || call.Args[0] != "a" {
		t.Fatalf("call = %+v", f.Body[1])
	}
	if call.P.Line != 5 {
		t.Errorf("call pos = %s", call.P)
	}
}

func TestParseCommentsAndBlankLines(t *testing.T) {
	prog := mustParse(t, "c.fx", "// header\nglobal g // trailing\n\nfn f():\n    // inner comment\n    read g\n")
	if len(prog.Globals) != 1 || len(prog.Funcs) != 1 || len(prog.Funcs[0].Body) != 1 {
		t.Fatalf("prog = %+v", prog)
	}
}

func TestParseErrors(t *testing.T) {
	cases := []struct {
		src  string
		want string
	}{
		{"read g\n", "e.fx:1:1"},
		{"fn f()\n", "e.fx:1:1"},
		{"fn f():\n    frobnicate x\n", "e.fx:2:5"},
		{"fn f():\nfn f():\n", "e.fx:2:1"},
		{"global g\nglobal g\n", "e.fx:2:1"},
	}
	for _, tc := range cases {
		_, err := Parse("e.fx", tc.src)
		if err == nil {
			t.Errorf("src %q: expected error", tc.src)
			continue
		}
		pe, ok := err.(*ParseError)
		if !ok {
			t.Errorf("src %q: error type %T", tc.src, err)
			continue
		}
		if pe.P.String() != tc.want {
			t.Errorf("src %q: pos = %s, want %s", tc.src, pe.P, tc.want)
		}
	}
}

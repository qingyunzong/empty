package bchandler

import (
	"bytes"
	"strings"
	"testing"
)

func TestReport(t *testing.T) {
	spec := Spec{
		Code: []string{"iconst_0", "istore_1", "iload_1", "idiv"},
		Handlers: []HandlerSpec{
			{Name: "outer", Start: 0, End: 4, Type: "java/lang/Throwable"},
			{Name: "inner", Start: 2, End: 3},
			{Name: "inner2", Start: 2, End: 3},
		},
		Inserts: []InsertSpec{{At: 1, Count: 2}},
	}
	var buf bytes.Buffer
	if err := Report(spec, nil, &buf); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{
		"code length: 4",
		"handlers: 3 (valid, no crossing intervals)",
		"2    iload_1      inner > inner2 > outer(java/lang/Throwable)",
		"after inserting 2 instruction(s) at 1 (code length 6):",
		"handler outer        [0,6)",
		"handler inner        [4,5)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report missing %q\ngot:\n%s", want, out)
		}
	}
}

func TestReportRejectsCrossing(t *testing.T) {
	spec := Spec{
		Length: 6,
		Handlers: []HandlerSpec{
			{Name: "a", Start: 0, End: 3},
			{Name: "b", Start: 2, End: 5},
		},
	}
	var buf bytes.Buffer
	err := Report(spec, nil, &buf)
	if err == nil || !strings.Contains(err.Error(), "cross") {
		t.Fatalf("want crossing error, got %v", err)
	}
}

func TestReportInsertOutOfRange(t *testing.T) {
	spec := Spec{
		Length:  2,
		Inserts: []InsertSpec{{At: 3, Count: 1}},
	}
	var buf bytes.Buffer
	if err := Report(spec, nil, &buf); err == nil {
		t.Fatal("want insert position error")
	}
}

func TestLoadSpec(t *testing.T) {
	spec, err := LoadSpec("testdata/example.json")
	if err != nil {
		t.Fatal(err)
	}
	if spec.CodeLen() != 8 || len(spec.Handlers) != 4 || len(spec.Inserts) != 1 {
		t.Fatalf("unexpected spec: %+v", spec)
	}
	var buf bytes.Buffer
	if err := Report(spec, nil, &buf); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, want := range []string{
		"3    iconst_2     load(java/lang/ArrayIndexOutOfBoundsException) > div(java/lang/ArithmeticException) > div2(java/lang/RuntimeException) > outer(java/lang/Throwable)",
		"handler load         [3,4)",
		"handler div          [2,7)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report missing %q\ngot:\n%s", want, out)
		}
	}
}

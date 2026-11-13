package dataeng

import (
	"math"
	"reflect"
	"testing"
)

func TestImplicitParentFromDottedKey(t *testing.T) {
	src := "a.b.c = 1\n"

	expected := newRefTable()
	if !expected.refSet([]string{"a", "b", "c"}, int64(1)) {
		t.Fatal("reference model rejected a valid dotted key")
	}
	assertParseMatches(t, src, expected)

	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := got.Lookup("a", "b", "c"); !ok || v != int64(1) {
		t.Fatalf("Lookup failed: %v %v", v, ok)
	}
	if _, ok := got.Get("a").(*Table); !ok {
		t.Fatal("implicit parent a is not a table")
	}
}

func TestImplicitParentThenExplicitHeader(t *testing.T) {
	src := "a.b = 1\n[a]\nc = 2\n"

	expected := newRefTable()
	if !expected.refSet([]string{"a", "b"}, int64(1)) {
		t.Fatal("reference setup failed")
	}
	aTable := expected.refHeader([]string{"a"}, map[string]bool{})
	if aTable == nil {
		t.Fatal("reference model could not open implicit parent [a]")
	}
	if !aTable.refSet([]string{"c"}, int64(2)) {
		t.Fatal("reference setup failed")
	}
	assertParseMatches(t, src, expected)
}

func TestExplicitTableHeaderCreatesParent(t *testing.T) {
	src := "[server.host]\nname = \"edge\"\n"

	expected := newRefTable()
	host := expected.refHeader([]string{"server", "host"}, map[string]bool{})
	if host == nil {
		t.Fatal("reference setup failed")
	}
	if !host.refSet([]string{"name"}, "edge") {
		t.Fatal("reference setup failed")
	}
	assertParseMatches(t, src, expected)
}

func TestParentDefinedAsNonTableBlocksWrites(t *testing.T) {
	assertParseError(t, "a = 1\na.b = 2\n")
	assertParseError(t, "a = 1\n[a.b]\nc = 2\n")
	assertParseError(t, "a = [1, 2]\na.b = 3\n")
	assertParseError(t, "a = \"x\"\n[[a.b]]\nc = 1\n")
}

func TestDuplicateBasicKeyFails(t *testing.T) {
	assertParseError(t, "a = 1\na = 2\n")
	assertParseError(t, "a = 1\na = 1\n")
	assertParseError(t, "a.b = 1\na.b = 2\n")
	assertParseError(t, "[t]\na = 1\na = 2\n")
	assertParseError(t, "[a]\nb = 1\nb = 2\n")
}

func TestDuplicateTableHeaderFails(t *testing.T) {
	assertParseError(t, "[a]\n[a]\n")
	assertParseError(t, "[a.b]\n[a]\n[a.b]\n")
}

func TestArrayTableAppends(t *testing.T) {
	src := "[[pipeline.stages]]\nname = \"build\"\n[[pipeline.stages]]\nname = \"test\"\n"

	expected := newRefTable()
	first := expected.refArrayHeader([]string{"pipeline", "stages"})
	if first == nil || !first.refSet([]string{"name"}, "build") {
		t.Fatal("reference setup failed")
	}
	second := expected.refArrayHeader([]string{"pipeline", "stages"})
	if second == nil || !second.refSet([]string{"name"}, "test") {
		t.Fatal("reference setup failed")
	}
	assertParseMatches(t, src, expected)

	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	stages, ok := got.Get("pipeline").(*Table).Get("stages").([]any)
	if !ok || len(stages) != 2 {
		t.Fatalf("expected 2 appended stages, got %#v", got.toMap())
	}
}

func TestArrayTableCannotReplaceScalarOrTable(t *testing.T) {
	// A scalar at the terminal key cannot become an array of tables.
	assertParseError(t, "a = 1\n[[a]]\nx = 1\n")
	// A standard table at the terminal key cannot be replaced by an array.
	assertParseError(t, "[a]\nx = 1\n[[a]]\ny = 2\n")
	// A plain scalar array is not an array of tables.
	assertParseError(t, "a = [1, 2]\n[[a]]\nx = 1\n")
}

func TestArrayTableNestingUnderLatestElement(t *testing.T) {
	src := "[[jobs]]\nname = \"one\"\n[[jobs]]\nname = \"two\"\n[[jobs.steps]]\nid = \"s1\"\n"

	expected := newRefTable()
	one := expected.refArrayHeader([]string{"jobs"})
	if one == nil || !one.refSet([]string{"name"}, "one") {
		t.Fatal("reference setup failed")
	}
	two := expected.refArrayHeader([]string{"jobs"})
	if two == nil || !two.refSet([]string{"name"}, "two") {
		t.Fatal("reference setup failed")
	}
	steps := two.refArrayHeader([]string{"steps"})
	if steps == nil || !steps.refSet([]string{"id"}, "s1") {
		t.Fatal("reference setup failed")
	}
	assertParseMatches(t, src, expected)
}

func TestArrayTableAppendOnlyThreeElements(t *testing.T) {
	src := "[[x]]\nv = 1\n[[x]]\nv = 2\n[[x]]\nv = 3\n"

	expected := newRefTable()
	for _, n := range []int64{1, 2, 3} {
		elem := expected.refArrayHeader([]string{"x"})
		if elem == nil || !elem.refSet([]string{"v"}, n) {
			t.Fatal("reference setup failed")
		}
	}
	assertParseMatches(t, src, expected)

	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	arr := got.Get("x").([]any)
	if len(arr) != 3 {
		t.Fatalf("expected 3 elements, got %d", len(arr))
	}
}

func TestAllowedStringEscapes(t *testing.T) {
	src := "a = \"quote: \\\" end\"\n" +
		"b = \"back: \\\\ end\"\n" +
		"c = \"nl: \\n end\"\n" +
		"d = \"cr: \\r end\"\n" +
		"e = \"tab: \\t end\"\n"
	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"a": "quote: \" end",
		"b": "back: \\ end",
		"c": "nl: \n end",
		"d": "cr: \r end",
		"e": "tab: \t end",
	}
	if !reflect.DeepEqual(got.toMap(), want) {
		t.Fatalf("escape mismatch\n got %#v\nwant %#v", got.toMap(), want)
	}
}

func TestRejectedStringEscapes(t *testing.T) {
	for _, src := range []string{
		"a = \"bad \\u0041\"\n",
		"a = \"bad \\b\"\n",
		"a = \"bad \\f\"\n",
		"a = \"bad \\/\"\n",
		"a = \"bad \\a\"\n",
		"a = \"bad \\0\"\n",
		"a = \"raw newline \n inside\"\n",
		"a = \"unterminated\n",
	} {
		assertParseError(t, src)
	}
}

func TestScalarsAndArrays(t *testing.T) {
	src := "i = 42\n" +
		"neg = -17\n" +
		"hex = 0xDEAD_BEEF\n" +
		"oct = 0o777\n" +
		"bin = 0b1010\n" +
		"f = 3.14\n" +
		"exp = 1e-3\n" +
		"flag = true\n" +
		"off = false\n" +
		"list = [1, 2, 3]\n" +
		"nested = [[1], [2, 3]]\n" +
		"mixed = [1, \"two\", true]\n" +
		"empty = []\n"
	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{
		"i":    int64(42),
		"neg":  int64(-17),
		"hex":  int64(0xDEADBEEF),
		"oct":  int64(511),
		"bin":  int64(10),
		"f":    3.14,
		"exp":  0.001,
		"flag": true,
		"off":  false,
		"list": []any{int64(1), int64(2), int64(3)},
		"nested": []any{
			[]any{int64(1)},
			[]any{int64(2), int64(3)},
		},
		"mixed": []any{int64(1), "two", true},
		"empty": []any{},
	}
	if !reflect.DeepEqual(got.toMap(), expected) {
		t.Fatalf("mismatch\n got %#v\nwant %#v", got.toMap(), expected)
	}
}

func TestInlineTable(t *testing.T) {
	src := "point = { x = 1, y = 2 }\n" +
		"nested = { a.b = 3 }\n" +
		"empty = {}\n"
	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{
		"point":  map[string]any{"x": int64(1), "y": int64(2)},
		"nested": map[string]any{"a": map[string]any{"b": int64(3)}},
		"empty":  map[string]any{},
	}
	if !reflect.DeepEqual(got.toMap(), expected) {
		t.Fatalf("mismatch\n got %#v\nwant %#v", got.toMap(), expected)
	}
}

func TestInlineTableDuplicateKeyFails(t *testing.T) {
	assertParseError(t, "t = { a = 1, a = 2 }\n")
	assertParseError(t, "t = { a.b = 1, a.c = 2, a.b = 3 }\n")
	assertParseError(t, "t = { a = 1, a.b = 2 }\n")
	assertParseError(t, "t = { a = 1, }\n")
}

func TestCommentsAndBlankLines(t *testing.T) {
	src := "# header comment\n\n  # indented comment\na = 1 # trailing\n\n"
	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.toMap(), map[string]any{"a": int64(1)}) {
		t.Fatalf("unexpected %#v", got.toMap())
	}
}

func TestQuotedKeys(t *testing.T) {
	src := "\"a.b\".\"c d\" = 7\n[\"weird.key\"]\nq = true\n"
	got, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	v, ok := got.Lookup("a.b", "c d")
	if !ok || v != int64(7) {
		t.Fatalf("quoted dotted key failed: %#v", got.toMap())
	}
	tbl, ok := got.Get("weird.key").(*Table)
	if !ok || tbl.Get("q") != true {
		t.Fatalf("quoted header failed: %#v", got.toMap())
	}
}

func TestBareHeaderIsDottedPath(t *testing.T) {
	src := "[weird.key]\nq = true\n"
	expected := newRefTable()
	tbl := expected.refHeader([]string{"weird", "key"}, map[string]bool{})
	if tbl == nil || !tbl.refSet([]string{"q"}, true) {
		t.Fatal("reference setup failed")
	}
	assertParseMatches(t, src, expected)
}

func TestBadNumbers(t *testing.T) {
	for _, src := range []string{
		"a = 01\n",
		"a = 1_00_\n",
		"a = _100\n",
		"a = 100_\n",
		"a = 0x\n",
		"a = 1.\n",
		"a = .5\n",
		"a = 1..2\n",
		"a = 99999999999999999999999999\n",
	} {
		assertParseError(t, src)
	}
}

func TestSpecialFloats(t *testing.T) {
	got, err := Parse("p = inf\nn = -inf\nz = nan\n")
	if err != nil {
		t.Fatal(err)
	}
	if !math.IsInf(got.Get("p").(float64), 1) {
		t.Fatal("expected +inf")
	}
	if !math.IsInf(got.Get("n").(float64), -1) {
		t.Fatal("expected -inf")
	}
	if !math.IsNaN(got.Get("z").(float64)) {
		t.Fatal("expected nan")
	}
}

func TestSyntaxErrors(t *testing.T) {
	for _, src := range []string{
		"a = \n",
		"a 1\n",
		"= 1\n",
		"[a\n",
		"a] = 1\n",
		"a = [1, 2\n",
		"a = [1 2]\n",
		"a = { b 1 }\n",
		"[a] extra = 1\n",
		"a = 1 b = 2\n",
		"a = \"unterminated\n",
		"..\n",
		"a..b = 1\n",
	} {
		assertParseError(t, src)
	}
}

func TestParseErrorPosition(t *testing.T) {
	src := "a = 1\nb = 2\nb = 3\n"
	_, err := Parse(src)
	if err == nil {
		t.Fatal("expected error")
	}
	pe := err.(*ParseError)
	if pe.Line != 3 {
		t.Fatalf("expected line 3, got %d (%v)", pe.Line, pe)
	}
	if pe.Column < 1 {
		t.Fatalf("invalid column: %d", pe.Column)
	}
}

func TestEmptyDocument(t *testing.T) {
	got, err := Parse("")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Keys()) != 0 {
		t.Fatalf("expected empty root, got %#v", got.toMap())
	}
}

func TestParseFileMissing(t *testing.T) {
	if _, err := ParseFile("definitely-missing-config.toml"); err == nil {
		t.Fatal("expected error for missing file")
	}
}

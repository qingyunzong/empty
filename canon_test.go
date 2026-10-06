package jsoncanon

import (
	"bytes"
	"encoding/json"
	"errors"
	"math/rand"
	"sort"
	"strings"
	"testing"
)

func canonString(t *testing.T, src string, opts *Options) string {
	t.Helper()
	v := mustParse(t, src)
	out, _, err := Canonicalize(v, opts)
	if err != nil {
		t.Fatalf("Canonicalize(%q): %v", src, err)
	}
	return string(out)
}

func TestCanonicalKeyOrderUTF8(t *testing.T) {
	src := `{"中": 1, "é": 2, "z": 3, "a": 4, "A": 5, "0": 6, "~": 7, "aa": 8}`
	got := canonString(t, src, nil)
	// Byte order: "0"(30) "A"(41) "a"(61) "aa" "z"(7a) "~"(7e) é(c3a9) 中(e4b8ad)
	want := `{"0":6,"A":5,"a":4,"aa":8,"z":3,"~":7,"é":2,"中":1}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDuplicateKeyRejected(t *testing.T) {
	for _, src := range []string{
		`{"a":1,"a":2}`,
		`{"a":1,"a":1}`,
		`{"a":1,"b":2,"a":3}`,
		`{"a":1,"a":2}`,
		`{"x":{"k":1,"k":2}}`,
	} {
		v := mustParse(t, src)
		_, _, err := Canonicalize(v, nil)
		var de *DuplicateKeyError
		if !errors.As(err, &de) {
			t.Errorf("Canonicalize(%q): got %v, want DuplicateKeyError", src, err)
		}
	}
}

func TestNumberPrecisionPreserved(t *testing.T) {
	src := `{"pi": 3.14159265358979323846264338327950288419716939937510582097494459,
	         "big": 12345678901234567890123456789012345678901234567890,
	         "tiny": 1e-999,
	         "neg": -0.0000000000000000000000000000000000001,
	         "exp": 6.02214076e+23}`
	got := canonString(t, src, nil)
	want := `{"big":12345678901234567890123456789012345678901234567890,"exp":6.02214076e+23,"neg":-0.0000000000000000000000000000000000001,"pi":3.14159265358979323846264338327950288419716939937510582097494459,"tiny":1e-999}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestCanonicalIsStrictJSON(t *testing.T) {
	src := `// c
	{"b": [1, 2,], "a": {"y": null,}, }`
	got := canonString(t, src, nil)
	var anyv any
	dec := json.NewDecoder(strings.NewReader(got))
	dec.UseNumber()
	if err := dec.Decode(&anyv); err != nil {
		t.Fatalf("canonical output is not strict JSON: %v", err)
	}
}

func TestIdempotent(t *testing.T) {
	src := `{"b": [3, 1.50, "x",], "a": {"é": true,},}`
	once := canonString(t, src, nil)
	twice := canonString(t, once, nil)
	if once != twice {
		t.Fatalf("not idempotent:\n%s\n%s", once, twice)
	}
}

// referenceCanon is an independent canonicalizer built on encoding/json:
// map keys are sorted by Go's stdlib in UTF-8 byte order, numbers are
// emitted verbatim via json.Number.
func referenceCanon(t *testing.T, v *Value) []byte {
	t.Helper()
	var conv func(v *Value) any
	conv = func(v *Value) any {
		switch v.Kind {
		case KindNull:
			return nil
		case KindBool:
			return v.Bool
		case KindNumber:
			return json.Number(v.Num)
		case KindString:
			return v.Str
		case KindArray:
			arr := make([]any, len(v.Arr))
			for i, el := range v.Arr {
				arr[i] = conv(el)
			}
			return arr
		case KindObject:
			m := make(map[string]any, len(v.Obj))
			for _, mem := range v.Obj {
				m[mem.Key] = conv(mem.Value)
			}
			return m
		}
		t.Fatalf("bad kind")
		return nil
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(conv(v)); err != nil {
		t.Fatalf("reference encode: %v", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// randValue generates a random JSON tree with unique object keys.
func randValue(r *rand.Rand, depth int) *Value {
	kinds := []Kind{KindNull, KindBool, KindNumber, KindString}
	if depth < 4 {
		kinds = append(kinds, KindArray, KindObject)
	}
	switch kinds[r.Intn(len(kinds))] {
	case KindBool:
		return &Value{Kind: KindBool, Bool: r.Intn(2) == 0}
	case KindNumber:
		return &Value{Kind: KindNumber, Num: randNumber(r)}
	case KindString:
		return &Value{Kind: KindString, Str: randString(r)}
	case KindArray:
		n := r.Intn(5)
		v := &Value{Kind: KindArray}
		for i := 0; i < n; i++ {
			v.Arr = append(v.Arr, randValue(r, depth+1))
		}
		return v
	case KindObject:
		n := r.Intn(6)
		v := &Value{Kind: KindObject}
		seen := map[string]bool{}
		for i := 0; i < n; i++ {
			k := randString(r)
			if seen[k] {
				continue
			}
			seen[k] = true
			v.Obj = append(v.Obj, Member{Key: k, Value: randValue(r, depth+1)})
		}
		return v
	}
	return &Value{Kind: KindNull}
}

func randNumber(r *rand.Rand) string {
	var b strings.Builder
	if r.Intn(2) == 0 {
		b.WriteByte('-')
	}
	if r.Intn(4) == 0 {
		b.WriteByte('0')
	} else {
		b.WriteByte(byte('1' + r.Intn(9)))
		for i := r.Intn(20); i > 0; i-- {
			b.WriteByte(byte('0' + r.Intn(10)))
		}
	}
	if r.Intn(2) == 0 {
		b.WriteByte('.')
		for i := 1 + r.Intn(25); i > 0; i-- {
			b.WriteByte(byte('0' + r.Intn(10)))
		}
	}
	if r.Intn(3) == 0 {
		if r.Intn(2) == 0 {
			b.WriteByte('e')
		} else {
			b.WriteByte('E')
		}
		switch r.Intn(3) {
		case 0:
			b.WriteByte('+')
		case 1:
			b.WriteByte('-')
		}
		for i := 1 + r.Intn(3); i > 0; i-- {
			b.WriteByte(byte('0' + r.Intn(10)))
		}
	}
	return b.String()
}

var randRunes = []rune("abcXYZ019 ~\té中😀\"\\/\b\f\n\r")

func randString(r *rand.Rand) string {
	n := r.Intn(8)
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteRune(randRunes[r.Intn(len(randRunes))])
	}
	return b.String()
}

// toJSONC renders a value back to the JSON-with-comments subset, randomly
// sprinkling whitespace, comments and trailing commas.
func toJSONC(r *rand.Rand, v *Value) string {
	var b strings.Builder
	pad := func() {
		for r.Intn(3) == 0 {
			switch r.Intn(4) {
			case 0:
				b.WriteString(" ")
			case 1:
				b.WriteString("\n  ")
			case 2:
				b.WriteString("/* x */")
			case 3:
				b.WriteString("// y\n")
			}
		}
	}
	var enc func(v *Value)
	enc = func(v *Value) {
		pad()
		switch v.Kind {
		case KindNull:
			b.WriteString("null")
		case KindBool:
			if v.Bool {
				b.WriteString("true")
			} else {
				b.WriteString("false")
			}
		case KindNumber:
			b.WriteString(v.Num)
		case KindString:
			writeJSONString(&b, v.Str)
		case KindArray:
			b.WriteByte('[')
			for i, el := range v.Arr {
				if i > 0 {
					b.WriteByte(',')
				}
				enc(el)
			}
			if len(v.Arr) > 0 && r.Intn(2) == 0 {
				b.WriteByte(',') // trailing comma
			}
			pad()
			b.WriteByte(']')
		case KindObject:
			b.WriteByte('{')
			for i, m := range v.Obj {
				if i > 0 {
					b.WriteByte(',')
				}
				pad()
				writeJSONString(&b, m.Key)
				pad()
				b.WriteByte(':')
				enc(m.Value)
			}
			if len(v.Obj) > 0 && r.Intn(2) == 0 {
				b.WriteByte(',') // trailing comma
			}
			pad()
			b.WriteByte('}')
		}
	}
	enc(v)
	pad()
	return b.String()
}

// TestRandomTreesAgainstReference round-trips random trees through the
// JSONC parser and checks the canonical output against an independent
// encoding/json-based reference, plus idempotence and strict-JSON
// re-parseability.
func TestRandomTreesAgainstReference(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		r := rand.New(rand.NewSource(seed))
		tree := randValue(r, 0)
		src := toJSONC(r, tree)

		v, err := Parse([]byte(src))
		if err != nil {
			t.Fatalf("seed %d: parse generated source: %v\n%s", seed, err, src)
		}
		got, _, err := Canonicalize(v, nil)
		if err != nil {
			t.Fatalf("seed %d: canonicalize: %v", seed, err)
		}
		want := referenceCanon(t, v)
		if !bytes.Equal(got, want) {
			t.Fatalf("seed %d mismatch:\ngot  %s\nwant %s\nsrc %s", seed, got, want, src)
		}

		// Canonical output must be strict JSON parseable by the stdlib.
		dec := json.NewDecoder(bytes.NewReader(got))
		dec.UseNumber()
		var anyv any
		if err := dec.Decode(&anyv); err != nil {
			t.Fatalf("seed %d: canonical output not strict JSON: %v", seed, err)
		}

		// Idempotence: canonicalizing the canonical form is a fixed point.
		v2, err := Parse(got)
		if err != nil {
			t.Fatalf("seed %d: reparse canonical: %v", seed, err)
		}
		got2, _, err := Canonicalize(v2, nil)
		if err != nil {
			t.Fatalf("seed %d: re-canonicalize: %v", seed, err)
		}
		if !bytes.Equal(got, got2) {
			t.Fatalf("seed %d: not idempotent:\n%s\n%s", seed, got, got2)
		}
	}
}

// TestSortedKeysMatchStdlib double-checks our ordering against sort.Strings.
func TestSortedKeysMatchStdlib(t *testing.T) {
	r := rand.New(rand.NewSource(99))
	for i := 0; i < 50; i++ {
		obj := &Value{Kind: KindObject}
		seen := map[string]bool{}
		for j := 0; j < 20; j++ {
			k := randString(r)
			if seen[k] || k == "" {
				continue
			}
			seen[k] = true
			obj.Obj = append(obj.Obj, Member{Key: k, Value: &Value{Kind: KindNull}})
		}
		out, _, err := Canonicalize(obj, nil)
		if err != nil {
			t.Fatal(err)
		}
		keys := make([]string, 0, len(seen))
		for k := range seen {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var want strings.Builder
		want.WriteByte('{')
		for j, k := range keys {
			if j > 0 {
				want.WriteByte(',')
			}
			writeJSONString(&want, k)
			want.WriteString(":null")
		}
		want.WriteByte('}')
		if string(out) != want.String() {
			t.Fatalf("iter %d:\ngot  %s\nwant %s", i, out, want.String())
		}
	}
}

func TestSpanCollectionInMemory(t *testing.T) {
	src := `{"b": [1, 2], "a": {"z": null}}`
	v := mustParse(t, src)
	_, res, err := Canonicalize(v, &Options{CollectSpans: true})
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]Span{}
	for _, se := range res.Spans {
		byPath[se.Path] = Span{se.Start, se.End}
	}
	checks := map[string]string{
		"":     src,
		"/a":   `{"z": null}`,
		"/a/z": `null`,
		"/b":   `[1, 2]`,
		"/b/0": `1`,
		"/b/1": `2`,
	}
	for path, text := range checks {
		sp, ok := byPath[path]
		if !ok {
			t.Fatalf("missing span for %q (have %v)", path, byPath)
		}
		if got := src[sp.Start:sp.End]; got != text {
			t.Errorf("path %q: span text %q want %q", path, got, text)
		}
	}
}

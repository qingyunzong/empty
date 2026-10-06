package norm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// randomValue builds a random JSON-compatible value tree. Numbers are
// generated in canonical form so the standard library can serve as a
// byte-exact reference.
func randomValue(rng *rand.Rand, depth int) any {
	choices := 6
	if depth > 5 {
		choices = 4
	}
	switch rng.Intn(choices) {
	case 0:
		return nil
	case 1:
		return rng.Intn(2) == 0
	case 2:
		return randomJSONString(rng, 12)
	case 3:
		return randomJSONNumber(rng)
	case 4:
		n := rng.Intn(6)
		arr := make([]any, n)
		for i := range arr {
			arr[i] = randomValue(rng, depth+1)
		}
		return arr
	default:
		n := rng.Intn(6)
		m := make(map[string]any, n)
		for len(m) < n {
			m[randomJSONString(rng, 6)] = randomValue(rng, depth+1)
		}
		return m
	}
}

var stringAlphabet = []rune{
	'a', 'Z', '0', '_', ' ', '"', '\\', '/', '<', '>', '&',
	'\n', '\t', '\r', 0x01, 0x1F, 0x7F,
	'é', '中', '😀', 0x2028, 0x2029, '´',
}

func randomJSONString(rng *rand.Rand, maxLen int) string {
	n := rng.Intn(maxLen + 1)
	rs := make([]rune, n)
	for i := range rs {
		rs[i] = stringAlphabet[rng.Intn(len(stringAlphabet))]
	}
	return string(rs)
}

func randomJSONNumber(rng *rand.Rand) json.Number {
	intLen := 1 + rng.Intn(25)
	digits := make([]byte, 0, intLen+20)
	digits = append(digits, byte('1'+rng.Intn(9)))
	for i := 1; i < intLen; i++ {
		digits = append(digits, byte('0'+rng.Intn(10)))
	}
	lit := string(digits)
	if rng.Intn(2) == 0 {
		frac := make([]byte, 1+rng.Intn(18))
		for i := range frac {
			frac[i] = byte('0' + rng.Intn(10))
		}
		lit += "." + string(frac)
	}
	if rng.Intn(2) == 0 {
		lit += fmt.Sprintf("e%+d", rng.Intn(121)-60)
	}
	if rng.Intn(2) == 0 {
		lit = "-" + lit
	}
	canon, err := canonicalNumber(lit)
	if err != nil {
		panic(err)
	}
	return json.Number(canon)
}

// renderLax serializes v in the relaxed input subset: random whitespace,
// comments and trailing commas.
func renderLax(rng *rand.Rand, v any, buf *bytes.Buffer) {
	pad := func() {
		for rng.Intn(3) == 0 {
			switch rng.Intn(4) {
			case 0:
				buf.WriteString(" ")
			case 1:
				buf.WriteString("\n")
			case 2:
				buf.WriteString("// comment\n")
			case 3:
				buf.WriteString("/* comment */")
			}
		}
	}
	pad()
	switch t := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case string:
		b, _ := json.Marshal(t)
		buf.Write(b)
	case json.Number:
		buf.WriteString(string(t))
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			renderLax(rng, e, buf)
		}
		if len(t) > 0 && rng.Intn(2) == 0 {
			pad()
			buf.WriteByte(',') // trailing comma
		}
		pad()
		buf.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		rng.Shuffle(len(keys), func(i, j int) { keys[i], keys[j] = keys[j], keys[i] })
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			pad()
			kb, _ := json.Marshal(k)
			buf.Write(kb)
			pad()
			buf.WriteByte(':')
			renderLax(rng, t[k], buf)
		}
		if len(t) > 0 && rng.Intn(2) == 0 {
			pad()
			buf.WriteByte(',') // trailing comma
		}
		pad()
		buf.WriteByte('}')
	default:
		panic(fmt.Sprintf("unexpected type %T", v))
	}
}

// referenceJSON renders v with the standard library: encoding/json sorts
// map keys in UTF-8 byte order, which is exactly the required output order.
func referenceJSON(t *testing.T, v any) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		t.Fatalf("reference encode: %v", err)
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func TestRandomTreesRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for i := 0; i < 400; i++ {
		v := randomValue(rng, 0)
		var src bytes.Buffer
		renderLax(rng, v, &src)

		got, err := normalizeToString(t, src.String(), 1<<30)
		if err != nil {
			t.Fatalf("iter %d: normalize(%q): %v", i, src.String(), err)
		}

		// Reference check against encoding/json.
		want := referenceJSON(t, v)
		if got != string(want) {
			t.Fatalf("iter %d:\nsrc:  %s\ngot:  %s\nwant: %s", i, src.String(), got, want)
		}

		// Semantic round trip: the normalized output must decode back to
		// the same value tree.
		dec := json.NewDecoder(bytes.NewReader([]byte(got)))
		dec.UseNumber()
		var back any
		if err := dec.Decode(&back); err != nil {
			t.Fatalf("iter %d: decode normalized output: %v", i, err)
		}
		if !reflect.DeepEqual(back, v) {
			t.Fatalf("iter %d: round trip mismatch:\nsrc: %s\ngot: %v\nwant: %v", i, src.String(), back, v)
		}

		// Idempotency: normalizing the normalized output is a fixed point.
		again, err := normalizeToString(t, got, 1<<30)
		if err != nil {
			t.Fatalf("iter %d: re-normalize: %v", i, err)
		}
		if again != got {
			t.Fatalf("iter %d: not idempotent:\nfirst:  %s\nsecond: %s", i, got, again)
		}

		// Low-budget (external sort) output must match full-memory output.
		if i%4 == 0 {
			low, err := normalizeToString(t, src.String(), 200)
			if err != nil {
				t.Fatalf("iter %d: low-budget normalize: %v", i, err)
			}
			if low != got {
				t.Fatalf("iter %d: low-budget output differs:\nfull: %s\nlow:  %s", i, got, low)
			}
		}
	}
}

func TestRandomTreesAreValidStrictJSON(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 100; i++ {
		v := randomValue(rng, 0)
		var src bytes.Buffer
		renderLax(rng, v, &src)
		got := mustNormalize(t, src.String(), 1<<30)
		if !json.Valid([]byte(got)) {
			t.Fatalf("iter %d: output is not strict JSON: %s", i, got)
		}
	}
}

package dataeng

import "testing"

func joinBytes(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func ascii(s string) []byte {
	return []byte(s)
}

// packedBytes builds a packed-decimal field independently of the decoder. For
// an even digit count it inserts the required high zero padding nibble.
func packedBytes(t *testing.T, digits string, sign byte) []byte {
	t.Helper()
	if len(digits) == 0 {
		t.Fatal("packedBytes needs at least one digit")
	}
	nibbles := make([]byte, 0, len(digits)+2)
	if (len(digits)+1)%2 == 1 {
		nibbles = append(nibbles, 0)
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			t.Fatalf("packedBytes digit %q is not decimal", c)
		}
		nibbles = append(nibbles, byte(c-'0'))
	}
	nibbles = append(nibbles, sign)
	if len(nibbles)%2 != 0 {
		t.Fatalf("packedBytes produced odd nibble count %d", len(nibbles))
	}
	out := make([]byte, len(nibbles)/2)
	for i, nibble := range nibbles {
		if i%2 == 0 {
			out[i/2] = nibble << 4
		} else {
			out[i/2] |= nibble
		}
	}
	return out
}

func mustCompile(t *testing.T, ast *AST) *Layout {
	t.Helper()
	layout, err := Compile(ast)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return layout
}

func mustDecode(t *testing.T, layout *Layout, data []byte, options ...DecodeOptions) *Record {
	t.Helper()
	record, err := layout.Decode(data, options...)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	return record
}

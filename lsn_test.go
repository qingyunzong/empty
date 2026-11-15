package dataeng

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestParseLSN(t *testing.T) {
	t.Parallel()

	cases := []struct {
		input string
		want  LSN
	}{
		{"0000002a:0000005c:0003", LSN{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 3}},
		{"0x0000002A0000005C0003", LSN{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 3}},
		{"0000002A0000005C0003", LSN{0, 0, 0, 0x2a, 0, 0, 0, 0x5c, 0, 3}},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.input, func(t *testing.T) {
			t.Parallel()
			got, err := ParseLSN(tc.input)
			if err != nil {
				t.Fatalf("ParseLSN() error = %v", err)
			}
			if !got.Equal(tc.want) {
				t.Fatalf("ParseLSN() = %x, want %x", got, tc.want)
			}
			if got.String() != "0000002a:0000005c:0003" {
				t.Fatalf("String() = %q", got.String())
			}
		})
	}

	for _, input := range []string{"", "xyz", "0000002a:0000005c", "0x1234"} {
		if _, err := ParseLSN(input); !errors.Is(err, ErrInvalidLSN) {
			t.Fatalf("ParseLSN(%q) error = %v, want ErrInvalidLSN", input, err)
		}
	}
}

func TestCompareLSN(t *testing.T) {
	t.Parallel()

	a := LSN{0, 0, 0, 0, 0, 0, 0, 2}
	b := LSN{0, 0, 0, 0, 0, 0, 0, 3}
	if CompareLSN(a, b) != -1 {
		t.Fatalf("CompareLSN(a, b) = %d", CompareLSN(a, b))
	}
	if CompareLSN(b, a) != 1 {
		t.Fatalf("CompareLSN(b, a) = %d", CompareLSN(b, a))
	}
	if CompareLSN(LSN{1}, LSN{0, 1}) != 0 {
		t.Fatal("shorter LSNs must be treated as left-padded")
	}
	if CompareLSN(LSN{1}, LSN{0, 2}) != -1 {
		t.Fatal("left-padded LSN comparison is not ordered")
	}
	if CompareLSN(nil, LSN{0}) != 0 {
		t.Fatal("nil and zero LSNs must compare equal")
	}
}

func TestIncrementDecrementLSN(t *testing.T) {
	t.Parallel()

	start := MustParseLSN("0000002a:0000005c:00ff")
	next, err := IncrementLSN(start)
	if err != nil {
		t.Fatalf("IncrementLSN() error = %v", err)
	}
	if got := next.String(); got != "0000002a:0000005c:0100" {
		t.Fatalf("IncrementLSN() = %s", got)
	}
	previous, err := DecrementLSN(next)
	if err != nil {
		t.Fatalf("DecrementLSN() error = %v", err)
	}
	if !previous.Equal(start) {
		t.Fatalf("DecrementLSN() = %s, want %s", previous, start)
	}

	allFF := LSN{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}
	if _, err := IncrementLSN(allFF); !errors.Is(err, ErrLSNOverflow) {
		t.Fatalf("IncrementLSN(max) error = %v", err)
	}
	if _, err := DecrementLSN(nil); !errors.Is(err, ErrLSNUnderflow) {
		t.Fatalf("DecrementLSN(zero) error = %v", err)
	}
}

func TestLSNJSON(t *testing.T) {
	t.Parallel()

	input := MustParseLSN("0000002a:0000005c:0003")
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if string(encoded) != `"0000002a:0000005c:0003"` {
		t.Fatalf("Marshal() = %s", encoded)
	}
	var decoded LSN
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if !decoded.Equal(input) {
		t.Fatalf("Unmarshal() = %s, want %s", decoded, input)
	}
}

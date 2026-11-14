package dataeng

import (
	"strings"
	"testing"
)

// ebcdic encodes ASCII text to EBCDIC bytes using the reverse of the
// generated code page table. Only needed by tests.
func ebcdic(t *testing.T, cp CodePage, s string) []byte {
	t.Helper()
	tab, err := cp.table()
	if err != nil {
		t.Fatal(err)
	}
	rev := make(map[rune]byte, 256)
	for b, r := range tab {
		if _, ok := rev[r]; !ok {
			rev[r] = byte(b)
		}
	}
	out := make([]byte, 0, len(s))
	for _, r := range s {
		b, ok := rev[r]
		if !ok {
			t.Fatalf("no EBCDIC mapping for %q", r)
		}
		out = append(out, b)
	}
	return out
}

func pad(s string, n int) string {
	if len(s) > n {
		panic("pad overflow")
	}
	return s + strings.Repeat(" ", n-len(s))
}

func testSchema() *Schema {
	return &Schema{
		Name:         "acct",
		Version:      "01",
		RecordLength: 18,
		CodePage:     CP037,
		Discriminator: &Discriminator{
			Offset: 0,
			Length: 2,
			Values: []string{"01"},
		},
		Fields: []Field{
			{Name: "VER", Offset: 0, Length: 2, Type: FieldString},
			{Name: "NAME", Offset: 2, Length: 8, Type: FieldString, Nullable: true},
			{Name: "AMT", Offset: 10, Length: 4, Type: FieldPackedDecimal, Scale: 2},
			{Name: "QTY", Offset: 14, Length: 4, Type: FieldZonedDecimal},
		},
	}
}

func buildRecord(t *testing.T, ver, name string, amt, qty []byte) []byte {
	t.Helper()
	rec := make([]byte, 0, 18)
	rec = append(rec, ebcdic(t, CP037, pad(ver, 2))...)
	rec = append(rec, ebcdic(t, CP037, pad(name, 8))...)
	rec = append(rec, amt...)
	rec = append(rec, qty...)
	if len(rec) != 18 {
		t.Fatalf("record length %d", len(rec))
	}
	return rec
}

func TestDecodePackedDecimal(t *testing.T) {
	cases := []struct {
		name    string
		raw     []byte
		want    Decimal
		wantErr bool
	}{
		{"positive C", []byte{0x12, 0x34, 0x5C}, Decimal{12345, 2}, false},
		{"negative D", []byte{0x12, 0x34, 0x5D}, Decimal{-12345, 2}, false},
		{"unsigned F", []byte{0x00, 0x00, 0x0F}, Decimal{0, 2}, false},
		{"bad digit nibble", []byte{0x1A, 0x34, 0x5C}, Decimal{}, true},
		{"bad sign nibble", []byte{0x12, 0x34, 0x51}, Decimal{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := Field{Name: "AMT", Offset: 0, Length: 3, Type: FieldPackedDecimal, Scale: 2}
			got, err := decodeField(CP037, f, tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDecodeZonedOverpunch(t *testing.T) {
	cases := []struct {
		name    string
		raw     []byte
		want    Decimal
		wantErr bool
	}{
		{"unsigned", []byte{0xF1, 0xF2, 0xF3}, Decimal{123, 0}, false},
		{"positive overpunch", []byte{0xF1, 0xF2, 0xC3}, Decimal{123, 0}, false},
		{"negative overpunch", []byte{0xF1, 0xF2, 0xD3}, Decimal{-123, 0}, false},
		{"negative zero overpunch", []byte{0xF1, 0xD0}, Decimal{-10, 0}, false},
		{"bad leading zone", []byte{0xC1, 0xF2, 0xF3}, Decimal{}, true},
		{"bad sign zone", []byte{0xF1, 0xF2, 0xE3}, Decimal{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := Field{Name: "QTY", Offset: 0, Length: len(tc.raw), Type: FieldZonedDecimal}
			got, err := decodeField(CP037, f, tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBlankPaddedValues(t *testing.T) {
	blank := []byte{0x40, 0x40, 0x40}

	nullable := Field{Name: "S", Offset: 0, Length: 3, Type: FieldString, Nullable: true}
	got, err := decodeField(CP037, nullable, blank)
	if err != nil || got != nil {
		t.Fatalf("nullable blank string: got %v, err %v", got, err)
	}

	required := Field{Name: "S", Offset: 0, Length: 3, Type: FieldString}
	if _, err := decodeField(CP037, required, blank); err == nil {
		t.Fatal("expected error for non-nullable blank string")
	}

	packedNullable := Field{Name: "P", Offset: 0, Length: 3, Type: FieldPackedDecimal, Nullable: true}
	if got, err := decodeField(CP037, packedNullable, blank); err != nil || got != nil {
		t.Fatalf("nullable blank packed: got %v, err %v", got, err)
	}
	packedRequired := Field{Name: "P", Offset: 0, Length: 3, Type: FieldPackedDecimal}
	if _, err := decodeField(CP037, packedRequired, blank); err == nil {
		t.Fatal("expected error for non-nullable blank packed")
	}

	zonedNullable := Field{Name: "Z", Offset: 0, Length: 3, Type: FieldZonedDecimal, Nullable: true}
	if got, err := decodeField(CP037, zonedNullable, blank); err != nil || got != nil {
		t.Fatalf("nullable blank zoned: got %v, err %v", got, err)
	}

	f := Field{Name: "S", Offset: 0, Length: 5, Type: FieldString}
	got, err = decodeField(CP037, f, ebcdic(t, CP037, "AB   "))
	if err != nil || got != "AB" {
		t.Fatalf("blank-padded string: got %q, err %v", got, err)
	}
}

func TestFieldErrorsAreIndependent(t *testing.T) {
	s := testSchema()
	rec := buildRecord(t, "01", "BOB",
		[]byte{0x12, 0x34, 0x51, 0x40}, // bad packed sign nibble
		[]byte{0xF1, 0xF2, 0xF3, 0xC4}) // valid zoned +1234
	got, errs := Decode(s, rec, 100)
	if len(errs) != 1 {
		t.Fatalf("expected 1 field error, got %d", len(errs))
	}
	if errs[0].Field != "AMT" {
		t.Fatalf("unexpected failing field %q", errs[0].Field)
	}
	if errs[0].Offset != 110 {
		t.Fatalf("field error offset: got %d, want 110", errs[0].Offset)
	}
	if got.Values["QTY"] != (Decimal{1234, 0}) {
		t.Fatalf("valid field lost: %v", got.Values["QTY"])
	}
	if got.Values["NAME"] != "BOB" {
		t.Fatalf("NAME: got %v", got.Values["NAME"])
	}
}

func TestDecimalString(t *testing.T) {
	if got := (Decimal{12345, 2}).String(); got != "123.45" {
		t.Fatal(got)
	}
	if got := (Decimal{-7, 3}).String(); got != "-0.007" {
		t.Fatal(got)
	}
}

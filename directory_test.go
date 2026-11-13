package dataeng

import (
	"math"
	"testing"
)

func TestDirectoryValueForms(t *testing.T) {
	tests := []struct {
		name     string
		value    any
		wantLen  uint64
		first    Token
		last     Token
		hasFirst bool
	}{
		{"string slice", []string{"a", "b", "a"}, 3, Known("a"), Known("a"), true},
		{"single string", "only", 1, Known("only"), Known("only"), true},
		{"slot slice", []Slot{KnownSlot("k"), UnknownSlot()}, 2, Known("k"), SharedUnknown("t", 2), true},
		{"table pointer", &Table{Slots: []Slot{KnownSlot("p")}}, 1, Known("p"), Known("p"), true},
		{"unknown marker slice", []Unknown{{}, {}}, 2, SharedUnknown("t", 1), SharedUnknown("t", 2), true},
		{"unknown numeric", UnknownSlots(3), 3, SharedUnknown("t", 1), SharedUnknown("t", 3), true},
		{"mixed metadata", Table{Slots: []Slot{KnownSlot("x")}, UnknownLength: 2}, 3, Known("x"), SharedUnknown("t", 3), true},
		{"nil value", nil, 0, Token{}, Token{}, false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := Directory{Key{"t", 1}: test.value}
			table, found, err := directory.Exact("t", 1)
			if err != nil || !found {
				t.Fatalf("Exact = (%v, %v, %v)", table, found, err)
			}
			if got := table.Len(); got != test.wantLen {
				t.Fatalf("table length = %d, want %d", got, test.wantLen)
			}

			context := mustContext(t, nil, []Import{{Name: "t", Version: 1}}, directory)
			if got, want := context.MaxSID(), test.wantLen; got != want {
				t.Fatalf("MaxSID = %d, want %d", got, want)
			}
			if test.hasFirst {
				if got := mustResolve(t, context, 1); !Equivalent(got, test.first) {
					t.Fatalf("first slot = %s, want %s", got, test.first)
				}
				if got := mustResolve(t, context, test.wantLen); !Equivalent(got, test.last) {
					t.Fatalf("last slot = %s, want %s", got, test.last)
				}
			}
		})
	}
}

func TestDirectoryPutAndValidate(t *testing.T) {
	directory := NewDirectory()
	if err := directory.Put("t", 1, []string{"a"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := directory.Put("t", 0, []string{"a"}); err == nil {
		t.Fatal("Put accepted version 0")
	}
	if err := directory.Put("", 1, []string{"a"}); err == nil {
		t.Fatal("Put accepted empty name")
	}
	if err := directory.Put("t", 2, 42); err == nil {
		t.Fatal("Put accepted unsupported value")
	}
	if err := directory.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestOverflowingDirectoryTableLengthRejected(t *testing.T) {
	directory := Directory{
		Key{"bad", 1}: Table{
			Slots:         []Slot{KnownSlot("x")},
			UnknownLength: math.MaxUint64,
		},
	}
	if _, err := NewContext(nil, []Import{{Name: "bad", Version: 1}}, directory); err == nil {
		t.Fatal("NewContext accepted an overflowing table length")
	}
}

package dataeng

import (
	"bytes"
	"encoding/hex"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	clean := strings.Map(func(r rune) rune {
		switch r {
		case ' ', '\n', '\t', '\r':
			return -1
		default:
			return r
		}
	}, s)
	b, err := hex.DecodeString(clean)
	if err != nil {
		t.Fatalf("bad fixture hex: %v", err)
	}
	return b
}

func TestUndefinedLengthSequence(t *testing.T) {
	data := mustHex(t, `
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 01 00 04 00 00 00 43 4F 44 45
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
		10 00 10 00 02 00 00 00 4A 44
	`)

	got, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	want := &DataSet{Elements: []*Element{
		{
			Tag:      Tag{Group: 0x0008, Element: 0x1111},
			Sequence: true,
			Length:   -1,
			Items: []*Item{
				{
					Length: -1,
					Elements: []*Element{
						{Tag: Tag{Group: 0x0008, Element: 0x0001}, Length: 4, Value: []byte("CODE")},
					},
				},
			},
		},
		{
			Tag:    Tag{Group: 0x0010, Element: 0x0010},
			Length: 2,
			Value:  []byte("JD"),
		},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tree mismatch\n got: %#v\nwant: %#v", got, want)
	}

	// Delimiter tags are structure, not data, at every depth.
	var walk func(elements []*Element)
	walk = func(elements []*Element) {
		for _, e := range elements {
			if e.Tag == ItemTag || e.Tag == ItemDelimiterTag || e.Tag == SequenceDelimiterTag {
				t.Fatalf("structural tag %s leaked into result", e.Tag)
			}
			for _, item := range e.Items {
				walk(item.Elements)
			}
		}
	}
	walk(got.Elements)
}

func TestDefinedItemDoesNotTreatDelimiterBytesAsStructure(t *testing.T) {
	// The item has a known length of 16 bytes. Its value is exactly an item
	// delimiter tag followed by a sequence delimiter tag, both of which must
	// remain payload because the item length is known.
	data := mustHex(t, `
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 10 00 00 00
		08 00 00 01 08 00 00 00 FE FF 0D E0 FE FF DD E0
		FE FF DD E0 00 00 00 00
	`)

	got, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	want := &DataSet{Elements: []*Element{
		{
			Tag:      Tag{Group: 0x0008, Element: 0x1111},
			Sequence: true,
			Length:   -1,
			Items: []*Item{
				{
					Length: 16,
					Elements: []*Element{
						{
							Tag:    Tag{Group: 0x0008, Element: 0x0100},
							Length: 8,
							Value:  []byte{0xFE, 0xFF, 0x0D, 0xE0, 0xFE, 0xFF, 0xDD, 0xE0},
						},
					},
				},
			},
		},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tree mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDefinedLeafValueMayEqualDelimiterTags(t *testing.T) {
	data := mustHex(t, `
		20 00 01 00 08 00 00 00 FE FF 0D E0 00 00 00 00
		20 00 02 00 08 00 00 00 FE FF DD E0 00 00 00 00
	`)

	got, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	want := &DataSet{Elements: []*Element{
		{
			Tag:    Tag{Group: 0x0020, Element: 0x0001},
			Length: 8,
			Value:  []byte{0xFE, 0xFF, 0x0D, 0xE0, 0x00, 0x00, 0x00, 0x00},
		},
		{
			Tag:    Tag{Group: 0x0020, Element: 0x0002},
			Length: 8,
			Value:  []byte{0xFE, 0xFF, 0xDD, 0xE0, 0x00, 0x00, 0x00, 0x00},
		},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tree mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestNestedSequenceDelimiterClosesOnlyInnermost(t *testing.T) {
	data := mustHex(t, `
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 12 12 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 02 00 02 00 00 00 41 42
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
		08 00 03 00 02 00 00 00 43 44
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
		10 00 10 00 02 00 00 00 45 46
	`)

	got, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	want := &DataSet{Elements: []*Element{
		{
			Tag:      Tag{Group: 0x0008, Element: 0x1111},
			Sequence: true,
			Length:   -1,
			Items: []*Item{
				{
					Length: -1,
					Elements: []*Element{
						{
							Tag:      Tag{Group: 0x0008, Element: 0x1212},
							Sequence: true,
							Length:   -1,
							Items: []*Item{
								{
									Length: -1,
									Elements: []*Element{
										{Tag: Tag{Group: 0x0008, Element: 0x0002}, Length: 2, Value: []byte("AB")},
									},
								},
							},
						},
						{Tag: Tag{Group: 0x0008, Element: 0x0003}, Length: 2, Value: []byte("CD")},
					},
				},
			},
		},
		{
			Tag:    Tag{Group: 0x0010, Element: 0x0010},
			Length: 2,
			Value:  []byte("EF"),
		},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tree mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestPrivateCreatorOrdering(t *testing.T) {
	valid := mustHex(t, `
		19 00 10 00 04 00 00 00 41 43 4D 45
		19 00 01 10 02 00 00 00 5A 31
	`)

	got, err := Parse(valid)
	if err != nil {
		t.Fatalf("valid creator order rejected: %v", err)
	}
	want := &DataSet{Elements: []*Element{
		{Tag: Tag{Group: 0x0019, Element: 0x0010}, Length: 4, Value: []byte("ACME")},
		{Tag: Tag{Group: 0x0019, Element: 0x1001}, Length: 2, Value: []byte("Z1")},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tree mismatch\n got: %#v\nwant: %#v", got, want)
	}

	invalid := mustHex(t, `
		19 00 01 10 02 00 00 00 5A 31
		19 00 10 00 04 00 00 00 41 43 4D 45
	`)
	_, err = Parse(invalid)
	if !errors.Is(err, ErrPrivateBeforeCreator) {
		t.Fatalf("want ErrPrivateBeforeCreator, got %v", err)
	}
	var pe *ParseError
	if !errors.As(err, &pe) {
		t.Fatalf("want *ParseError, got %T", err)
	}
	if pe.Offset != 0 {
		t.Fatalf("want failure at offset 0, got %d", pe.Offset)
	}
}

func TestPrivateCreatorIsScopedToItsLayer(t *testing.T) {
	outerCreatorThenPrivateInItem := mustHex(t, `
		19 00 10 00 04 00 00 00 41 43 4D 45
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		19 00 01 10 02 00 00 00 5A 31
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
	`)
	if _, err := Parse(outerCreatorThenPrivateInItem); !errors.Is(err, ErrPrivateBeforeCreator) {
		t.Fatalf("outer creator must not authorize item private data, got %v", err)
	}

	creatorInsideItem := mustHex(t, `
		19 00 10 00 04 00 00 00 41 43 4D 45
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		19 00 10 00 04 00 00 00 42 45 54 41
		19 00 01 10 02 00 00 00 5A 32
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
	`)
	got, err := Parse(creatorInsideItem)
	if err != nil {
		t.Fatalf("creator in item layer rejected: %v", err)
	}
	item := got.Elements[1].Items[0]
	want := []*Element{
		{Tag: Tag{Group: 0x0019, Element: 0x0010}, Length: 4, Value: []byte("BETA")},
		{Tag: Tag{Group: 0x0019, Element: 0x1001}, Length: 2, Value: []byte("Z2")},
	}
	if !reflect.DeepEqual(item.Elements, want) {
		t.Fatalf("item elements mismatch\n got: %#v\nwant: %#v", item.Elements, want)
	}
}

func TestHostByteLimit(t *testing.T) {
	data := mustHex(t, `
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 01 00 04 00 00 00 43 4F 44 45
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
		10 00 10 00 02 00 00 00 4A 44
	`)

	_, err := ParseWithOptions(data, Options{MaxBytes: int64(len(data) - 1)})
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}

	_, err = ParseWithLimit(data, int64(len(data)))
	if err != nil {
		t.Fatalf("exact host limit rejected: %v", err)
	}

	_, err = ReadDataSetWithOptions(bytes.NewReader(data), Options{MaxBytes: int64(len(data) - 1)})
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("reader want ErrTooLarge, got %v", err)
	}
}

func TestMissingDelimiters(t *testing.T) {
	missingSequenceDelimiter := mustHex(t, `
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 01 00 04 00 00 00 43 4F 44 45
		FE FF 0D E0 00 00 00 00
	`)
	if _, err := Parse(missingSequenceDelimiter); !errors.Is(err, ErrMissingDelimiter) {
		t.Fatalf("want ErrMissingDelimiter, got %v", err)
	}

	missingItemDelimiter := mustHex(t, `
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 01 00 04 00 00 00 43 4F 44 45
		FE FF DD E0 00 00 00 00
	`)
	if _, err := Parse(missingItemDelimiter); !errors.Is(err, ErrUnexpectedDelimiter) {
		t.Fatalf("want ErrUnexpectedDelimiter, got %v", err)
	}
}

func TestKnownLengthSequenceRequiresDictionaryTag(t *testing.T) {
	data := mustHex(t, `
		08 00 11 11 10 00 00 00
		FE FF 00 E0 08 00 00 00
		08 00 01 00 00 00 00 00
	`)

	// Without dictionary knowledge the defined-length bytes are opaque.
	plain, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if plain.Elements[0].Sequence {
		t.Fatal("defined-length element was treated as a sequence without dictionary knowledge")
	}
	if len(plain.Elements[0].Value) != 16 {
		t.Fatalf("want 16 opaque value bytes, got %d", len(plain.Elements[0].Value))
	}

	withDictionary, err := ParseWithOptions(data, Options{
		SequenceTags: map[Tag]bool{{Group: 0x0008, Element: 0x1111}: true},
	})
	if err != nil {
		t.Fatalf("ParseWithOptions: %v", err)
	}
	if !withDictionary.Elements[0].Sequence {
		t.Fatal("dictionary tag was not parsed as a sequence")
	}
	if len(withDictionary.Elements[0].Items) != 1 {
		t.Fatalf("want 1 item, got %d", len(withDictionary.Elements[0].Items))
	}
}

func TestMaxDepth(t *testing.T) {
	data := mustHex(t, `
		08 00 11 11 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 12 12 FF FF FF FF
		FE FF 00 E0 FF FF FF FF
		08 00 02 00 00 00 00 00
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
		FE FF 0D E0 00 00 00 00
		FE FF DD E0 00 00 00 00
	`)
	if _, err := ParseWithOptions(data, Options{MaxDepth: 2}); !errors.Is(err, ErrMaxDepth) {
		t.Fatalf("want ErrMaxDepth, got %v", err)
	}
}

func TestMalformedStructures(t *testing.T) {
	tests := []struct {
		name string
		hex  string
		want error
	}{
		{
			name: "sequence delimiter with length",
			hex: `
				08 00 11 11 FF FF FF FF
				FE FF DD E0 01 00 00 00
			`,
			want: ErrInvalidDelimiterValue,
		},
		{
			name: "item delimiter with length",
			hex: `
				08 00 11 11 FF FF FF FF
				FE FF 00 E0 FF FF FF FF
				FE FF 0D E0 01 00 00 00
			`,
			want: ErrInvalidDelimiterValue,
		},
		{
			name: "defined item crosses sequence",
			hex: `
				08 00 11 11 FF FF FF FF
				FE FF 00 E0 20 00 00 00
			`,
			want: ErrInvalidLength,
		},
		{
			name: "defined value crosses data set",
			hex: `
				20 00 01 00 0A 00 00 00 41 42 43 44
			`,
			want: ErrInvalidLength,
		},
		{
			name: "item outside sequence",
			hex: `
				FE FF 00 E0 00 00 00 00
			`,
			want: ErrUnexpectedDelimiter,
		},
		{
			name: "element where item is required",
			hex: `
				08 00 11 11 FF FF FF FF
				08 00 12 12 00 00 00 00
			`,
			want: ErrExpectedItem,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse(mustHex(t, tt.hex))
			if !errors.Is(err, tt.want) {
				t.Fatalf("want %v, got %v", tt.want, err)
			}
		})
	}
}

func TestEmptyDataSetAndZeroLengthValues(t *testing.T) {
	got, err := Parse(nil)
	if err != nil {
		t.Fatalf("Parse(nil): %v", err)
	}
	if len(got.Elements) != 0 {
		t.Fatalf("want empty data set, got %d elements", len(got.Elements))
	}

	data := mustHex(t, `20 00 01 00 00 00 00 00`)
	got, err = Parse(data)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := &DataSet{Elements: []*Element{
		{Tag: Tag{Group: 0x0020, Element: 0x0001}, Length: 0, Value: []byte{}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed tree mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

type auditEvent struct {
	Kind   string
	Tag    Tag
	Depth  int
	Offset int64
}

type auditFrame struct {
	kind string
	end  int64
}

// auditDelimiters is an independent stack-based reader used only by tests.
// It walks the encoded bytes by declared lengths, so delimiter-looking bytes
// inside values cannot affect it. It reports sequence/item openings and
// closings, which lets tests prove that a delimiter closes only the innermost
// frame and that an item's defined length suppresses false delimiters.
func auditDelimiters(t *testing.T, data []byte) []auditEvent {
	t.Helper()

	events := make([]auditEvent, 0, 16)
	stack := []auditFrame{{kind: "dataset", end: int64(len(data))}}
	pos := int64(0)

	depth := func() int {
		return len(stack) - 1
	}

	for len(stack) > 0 {
		top := stack[len(stack)-1]
		boundary := int64(len(data))
		if top.end >= 0 {
			boundary = top.end
		}

		if pos > boundary {
			t.Fatalf("audit: position %d crosses %s boundary %d", pos, top.kind, boundary)
		}
		if pos == boundary {
			if top.kind == "dataset" {
				stack = stack[:len(stack)-1]
				continue
			}
			if top.end < 0 {
				t.Fatalf("audit: missing delimiter for %s at %d", top.kind, pos)
			}
			events = append(events, auditEvent{Kind: top.kind + "-end", Depth: depth(), Offset: pos})
			stack = stack[:len(stack)-1]
			continue
		}
		if boundary-pos < 8 {
			t.Fatalf("audit: truncated header at %d", pos)
		}

		start := pos
		b := data[pos : pos+8]
		tag := Tag{
			Group:   uint16(b[0]) | uint16(b[1])<<8,
			Element: uint16(b[2]) | uint16(b[3])<<8,
		}
		length := uint32(b[4]) | uint32(b[5])<<8 | uint32(b[6])<<16 | uint32(b[7])<<24
		pos += 8

		if top.kind == "sequence" {
			switch tag {
			case SequenceDelimiterTag:
				if length != 0 {
					t.Fatalf("audit: sequence delimiter length %d", length)
				}
				events = append(events, auditEvent{Kind: "sequence-end", Tag: tag, Depth: depth(), Offset: start})
				stack = stack[:len(stack)-1]
				continue
			case ItemTag:
				itemEnd := int64(-1)
				if length != undefinedLength {
					itemEnd = pos + int64(length)
					if itemEnd > boundary {
						t.Fatalf("audit: item at %d crosses sequence end", start)
					}
				}
				stack = append(stack, auditFrame{kind: "item", end: itemEnd})
				events = append(events, auditEvent{Kind: "item", Tag: tag, Depth: depth(), Offset: start})
				continue
			default:
				t.Fatalf("audit: expected item, got %s at %d", tag, start)
			}
		}

		if top.kind == "item" && tag == ItemDelimiterTag {
			if length != 0 {
				t.Fatalf("audit: item delimiter length %d", length)
			}
			events = append(events, auditEvent{Kind: "item-end", Tag: tag, Depth: depth(), Offset: start})
			stack = stack[:len(stack)-1]
			continue
		}
		if tag.Group == 0xFFFE {
			t.Fatalf("audit: structural tag %s in %s at %d", tag, top.kind, start)
		}

		if length == undefinedLength {
			stack = append(stack, auditFrame{kind: "sequence", end: -1})
			events = append(events, auditEvent{Kind: "sequence", Tag: tag, Depth: depth(), Offset: start})
			continue
		}
		events = append(events, auditEvent{Kind: "element", Tag: tag, Depth: depth(), Offset: start})
		if pos+int64(length) > boundary {
			t.Fatalf("audit: value at %d crosses %s boundary", start, top.kind)
		}
		pos += int64(length)
	}

	return events
}

func TestIndependentDelimiterStack(t *testing.T) {
	t.Run("nested closing", func(t *testing.T) {
		data := mustHex(t, `
			08 00 11 11 FF FF FF FF
			FE FF 00 E0 FF FF FF FF
			08 00 12 12 FF FF FF FF
			FE FF 00 E0 FF FF FF FF
			08 00 02 00 02 00 00 00 41 42
			FE FF 0D E0 00 00 00 00
			FE FF DD E0 00 00 00 00
			08 00 03 00 02 00 00 00 43 44
			FE FF 0D E0 00 00 00 00
			FE FF DD E0 00 00 00 00
			10 00 10 00 02 00 00 00 45 46
		`)

		want := []auditEvent{
			{Kind: "sequence", Tag: Tag{Group: 0x0008, Element: 0x1111}, Depth: 1, Offset: 0},
			{Kind: "item", Tag: ItemTag, Depth: 2, Offset: 8},
			{Kind: "sequence", Tag: Tag{Group: 0x0008, Element: 0x1212}, Depth: 3, Offset: 16},
			{Kind: "item", Tag: ItemTag, Depth: 4, Offset: 24},
			{Kind: "element", Tag: Tag{Group: 0x0008, Element: 0x0002}, Depth: 4, Offset: 32},
			{Kind: "item-end", Tag: ItemDelimiterTag, Depth: 4, Offset: 42},
			{Kind: "sequence-end", Tag: SequenceDelimiterTag, Depth: 3, Offset: 50},
			{Kind: "element", Tag: Tag{Group: 0x0008, Element: 0x0003}, Depth: 2, Offset: 58},
			{Kind: "item-end", Tag: ItemDelimiterTag, Depth: 2, Offset: 68},
			{Kind: "sequence-end", Tag: SequenceDelimiterTag, Depth: 1, Offset: 76},
			{Kind: "element", Tag: Tag{Group: 0x0010, Element: 0x0010}, Depth: 0, Offset: 84},
		}
		got := auditDelimiters(t, data)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("audit mismatch\n got: %#v\nwant: %#v", got, want)
		}
	})

	t.Run("defined item false delimiter", func(t *testing.T) {
		data := mustHex(t, `
			08 00 11 11 FF FF FF FF
			FE FF 00 E0 10 00 00 00
			08 00 00 01 08 00 00 00 FE FF 0D E0 FE FF DD E0
			FE FF DD E0 00 00 00 00
		`)

		want := []auditEvent{
			{Kind: "sequence", Tag: Tag{Group: 0x0008, Element: 0x1111}, Depth: 1, Offset: 0},
			{Kind: "item", Tag: ItemTag, Depth: 2, Offset: 8},
			{Kind: "element", Tag: Tag{Group: 0x0008, Element: 0x0100}, Depth: 2, Offset: 16},
			{Kind: "item-end", Depth: 2, Offset: 32},
			{Kind: "sequence-end", Tag: SequenceDelimiterTag, Depth: 1, Offset: 32},
		}
		got := auditDelimiters(t, data)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("audit mismatch\n got: %#v\nwant: %#v", got, want)
		}
	})
}

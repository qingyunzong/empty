package dataeng

import (
	"errors"
	"math/big"
	"testing"
)

func TestDynamicArraySuccessorOffset(t *testing.T) {
	ast := &AST{Root: &Node{
		Path: "ROOT",
		Kind: Group,
		Children: []*Node{
			{Path: "CNT", Kind: UnsignedDisplay, Digits: 2},
			{Path: "ARR", Kind: Group, Occurs: UpTo(4, "CNT"), Children: []*Node{
				{Path: "ITEM", Kind: SignedPacked, Digits: 2},
			}},
			{Path: "TAIL", Kind: UnsignedDisplay, Digits: 3},
		},
	}}
	layout := mustCompile(t, ast)
	if layout.MaxSize() != 13 || layout.MinSize() != 5 {
		t.Fatalf("sizes = min %d max %d, want min 5 max 13", layout.MinSize(), layout.MaxSize())
	}

	data := joinBytes(
		ascii("03"),
		packedBytes(t, "12", 0x0c),
		packedBytes(t, "45", 0x0f),
		packedBytes(t, "67", 0x0d),
		ascii("999"),
	)
	record := mustDecode(t, layout, data, DecodeOptions{MaxLeaves: 16})
	if record.Size != 11 || record.Leaves != 5 {
		t.Fatalf("record size/leaves = %d/%d, want 11/5", record.Size, record.Leaves)
	}

	items := record.Find("ITEM")
	if len(items) != 3 {
		t.Fatalf("ITEM occurrences = %d, want 3", len(items))
	}
	want := []struct {
		start int
		text  string
	}{{2, "12"}, {4, "45"}, {6, "-67"}}
	for i, item := range items {
		if item.Start != want[i].start || item.Value.String() != want[i].text {
			t.Fatalf("ITEM[%d] = start %d value %s, want start %d value %s",
				i, item.Start, item.Value.String(), want[i].start, want[i].text)
		}
	}
	tail := record.First("TAIL")
	if tail == nil || tail.Start != 8 || tail.End != 11 || tail.Value.String() != "999" {
		t.Fatalf("TAIL = %#v, want start 8 end 11 value 999", tail)
	}

	// A shorter count moves the successor left by the unused item space.
	short := joinBytes(ascii("01"), packedBytes(t, "12", 0x0c), ascii("777"))
	shortRecord := mustDecode(t, layout, short)
	if got := shortRecord.First("TAIL"); got == nil || got.Start != 4 {
		t.Fatalf("TAIL with one item starts at %#v, want 4", got)
	}
}

func TestNestedFixedRepetition(t *testing.T) {
	ast := &AST{Root: &Node{
		Path: "ROOT",
		Kind: Group,
		Children: []*Node{
			{Path: "HEAD", Kind: UnsignedDisplay, Digits: 2},
			{Path: "OUTER", Kind: Group, Occurs: Fixed(2), Children: []*Node{
				{Path: "TAG", Kind: UnsignedDisplay, Digits: 1},
				{Path: "INNER", Kind: Group, Occurs: Fixed(2), Children: []*Node{
					{Path: "VAL", Kind: SignedPacked, Digits: 3},
				}},
			}},
			{Path: "END", Kind: RawBytes, Bytes: 1},
		},
	}}
	layout := mustCompile(t, ast)
	if layout.MinSize() != 13 || layout.MaxSize() != 13 {
		t.Fatalf("sizes = min %d max %d, want 13/13", layout.MinSize(), layout.MaxSize())
	}

	data := joinBytes(
		ascii("00"),
		ascii("1"), packedBytes(t, "123", 0x0c), packedBytes(t, "456", 0x0f),
		ascii("2"), packedBytes(t, "789", 0x0c), packedBytes(t, "012", 0x0d),
		[]byte{'Z'},
	)
	record := mustDecode(t, layout, data)
	if record.Size != 13 || record.Leaves != 1+2+4+1 {
		t.Fatalf("record size/leaves = %d/%d, want 13/8", record.Size, record.Leaves)
	}

	outers := record.Find("OUTER")
	if len(outers) != 2 || outers[0].Start != 2 || outers[0].End != 7 ||
		outers[1].Start != 7 || outers[1].End != 12 {
		t.Fatalf("OUTER occurrences = %#v", outers)
	}
	tags := record.Find("TAG")
	if len(tags) != 2 || tags[0].Start != 2 || tags[1].Start != 7 {
		t.Fatalf("TAG occurrences = %#v", tags)
	}
	vals := record.Find("VAL")
	if len(vals) != 4 {
		t.Fatalf("VAL occurrences = %d, want 4", len(vals))
	}
	wantStarts := []int{3, 5, 8, 10}
	wantValues := []string{"123", "456", "789", "-12"}
	for i, val := range vals {
		if val.Start != wantStarts[i] || val.Value.String() != wantValues[i] {
			t.Fatalf("VAL[%d] = start %d value %s, want start %d value %s",
				i, val.Start, val.Value.String(), wantStarts[i], wantValues[i])
		}
	}
	end := record.First("END")
	if end == nil || end.Start != 12 || string(end.Raw) != "Z" {
		t.Fatalf("END = %#v, want start 12 raw Z", end)
	}
}

func TestPackedWidthsAndNegativeZero(t *testing.T) {
	ast := &AST{Root: &Node{
		Path: "ROOT",
		Kind: Group,
		Children: []*Node{
			{Path: "P1", Kind: SignedPacked, Digits: 1},
			{Path: "P2", Kind: SignedPacked, Digits: 2},
			{Path: "P3", Kind: SignedPacked, Digits: 3},
			{Path: "P4", Kind: SignedPacked, Digits: 4},
			{Path: "P5", Kind: SignedPacked, Digits: 5},
			{Path: "NZ", Kind: SignedPacked, Digits: 4, Scale: 2},
			{Path: "NN", Kind: SignedPacked, Digits: 4, Scale: 2},
		},
	}}
	layout := mustCompile(t, ast)

	data := joinBytes(
		packedBytes(t, "5", 0x0c),     // 1 byte, odd width
		packedBytes(t, "12", 0x0c),    // 2 bytes, even width
		packedBytes(t, "123", 0x0c),   // 2 bytes, odd width
		packedBytes(t, "1234", 0x0c),  // 3 bytes, even width
		packedBytes(t, "12345", 0x0c), // 3 bytes, odd width
		packedBytes(t, "0000", 0x0d),  // negative zero
		packedBytes(t, "0012", 0x0d),  // -0.12
	)
	record := mustDecode(t, layout, data)

	want := map[string]string{"P1": "5", "P2": "12", "P3": "123", "P4": "1234", "P5": "12345"}
	for path, text := range want {
		field := record.First(path)
		if field == nil || field.Value.String() != text {
			t.Fatalf("%s = %v, want %s", path, field, text)
		}
	}

	nz := record.First("NZ")
	if nz == nil || nz.Value.Value.Sign() != 0 || nz.Value.Scale != 2 ||
		nz.Value.String() != "0.00" || nz.Value.Start != 11 || nz.Value.End != 14 {
		t.Fatalf("negative zero = %#v", nz)
	}
	if nz.Value.Value.Cmp(big.NewInt(0)) != 0 {
		t.Fatalf("negative zero value is not zero")
	}
	nn := record.First("NN")
	if nn == nil || nn.Value.String() != "-0.12" || nn.Value.Scale != 2 {
		t.Fatalf("negative nonzero = %#v", nn)
	}
}

func TestPackedRejectsBadPaddingDigitAndSign(t *testing.T) {
	tests := []struct {
		name   string
		digits int
		data   []byte
		code   DecodeErrorCode
		offset int
	}{
		{"even high padding must be zero", 4, []byte{0x11, 0x23, 0x4c}, ErrDigit, 0},
		{"digit nibble", 3, []byte{0x1a, 0x3c}, ErrDigit, 0},
		{"third digit nibble", 3, []byte{0x12, 0xac}, ErrDigit, 1},
		{"sign nibble", 3, []byte{0x12, 0x35}, ErrSign, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ast := &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
				{Path: "P", Kind: SignedPacked, Digits: tt.digits},
			}}}
			layout := mustCompile(t, ast)
			record, err := layout.Decode(tt.data)
			if record != nil {
				t.Fatalf("partial record was delivered: %#v", record)
			}
			var decodeErr *DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("error = %v, want *DecodeError", err)
			}
			if decodeErr.Code != tt.code || decodeErr.Path != "P" || decodeErr.Offset != tt.offset {
				t.Fatalf("error = %#v, want code %s path P offset %d", decodeErr, tt.code, tt.offset)
			}
		})
	}
}

func TestDisplayRejectsNonDigitWithExactOffset(t *testing.T) {
	ast := &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
		{Path: "HEAD", Kind: UnsignedDisplay, Digits: 1},
		{Path: "P", Kind: UnsignedDisplay, Digits: 2},
	}}}
	layout := mustCompile(t, ast)
	record, err := layout.Decode([]byte{'7', '1', 'A'})
	if record != nil {
		t.Fatalf("partial record was delivered")
	}
	var decodeErr *DecodeError
	if !errors.As(err, &decodeErr) {
		t.Fatalf("error = %v, want *DecodeError", err)
	}
	if decodeErr.Code != ErrDigit || decodeErr.Path != "P" || decodeErr.Offset != 2 {
		t.Fatalf("error = %#v, want digit at P offset 2", decodeErr)
	}
}

func TestShortOverlayBranchReservesMaximumSpace(t *testing.T) {
	ast := &AST{
		Root: &Node{
			Path: "ROOT",
			Kind: Group,
			Children: []*Node{
				{Path: "KIND", Kind: UnsignedDisplay, Digits: 1},
				{Path: "SHORT", Kind: UnsignedDisplay, Digits: 2, Overlay: "O"},
				{Path: "LONG", Kind: Group, Overlay: "O", Children: []*Node{
					{Path: "L1", Kind: UnsignedDisplay, Digits: 4},
					{Path: "L2", Kind: RawBytes, Bytes: 2},
				}},
				{Path: "NEXT", Kind: UnsignedDisplay, Digits: 1},
			},
		},
		Overlays: []Overlay{{
			Name:    "O",
			Control: "KIND",
			Branches: map[uint64]string{
				1: "SHORT",
				2: "LONG",
			},
		}},
	}
	layout := mustCompile(t, ast)
	if layout.MinSize() != 8 || layout.MaxSize() != 8 {
		t.Fatalf("sizes = min %d max %d, want fixed 8", layout.MinSize(), layout.MaxSize())
	}

	// The four bytes after SHORT are the unselected LONG branch. They contain
	// invalid display digits and must not be inspected.
	shortData := joinBytes(ascii("1"), ascii("42"), []byte{0xaa, 0xbb, 0xcc, 0xdd}, ascii("7"))
	record := mustDecode(t, layout, shortData)
	short := record.First("SHORT")
	if short == nil || short.Start != 1 || short.End != 3 || short.Value.String() != "42" {
		t.Fatalf("SHORT = %#v", short)
	}
	if record.First("LONG") != nil || record.First("L1") != nil || record.First("L2") != nil {
		t.Fatalf("unselected overlay branch was decoded")
	}
	next := record.First("NEXT")
	if next == nil || next.Start != 7 || next.End != 8 || next.Value.String() != "7" {
		t.Fatalf("NEXT = %#v, want start 7", next)
	}

	longData := joinBytes(ascii("2"), ascii("1234"), []byte{0xaa, 0xbb}, ascii("7"))
	longRecord := mustDecode(t, layout, longData)
	long := longRecord.First("LONG")
	if long == nil || long.Start != 1 || long.End != 7 {
		t.Fatalf("LONG = %#v", long)
	}
	if got := longRecord.First("NEXT"); got == nil || got.Start != 7 {
		t.Fatalf("NEXT after long branch = %#v, want start 7", got)
	}

	// Even a selected short branch must be backed by the full reserved span.
	truncated := joinBytes(ascii("1"), ascii("42"))
	if record, err := layout.Decode(truncated); record != nil || err == nil {
		t.Fatalf("short overlay without reserved span decoded: %#v, %v", record, err)
	}

	// Unknown control values are rejected.
	unknown := joinBytes(ascii("9"), ascii("42"), []byte{0xaa, 0xbb, 0xcc, 0xdd}, ascii("7"))
	record, err := layout.Decode(unknown)
	if record != nil {
		t.Fatalf("unknown branch delivered a record")
	}
	var decodeErr *DecodeError
	if !errors.As(err, &decodeErr) || decodeErr.Code != ErrBranch || decodeErr.Path != "KIND" {
		t.Fatalf("unknown branch error = %v", err)
	}
}

func TestCountBoundsLeafLimitAndZeroCount(t *testing.T) {
	ast := &AST{Root: &Node{
		Path: "ROOT",
		Kind: Group,
		Children: []*Node{
			{Path: "CNT", Kind: UnsignedDisplay, Digits: 2},
			{Path: "ARR", Kind: Group, Occurs: UpTo(3, "CNT"), Children: []*Node{
				{Path: "V", Kind: UnsignedDisplay, Digits: 4},
			}},
			{Path: "TAIL", Kind: UnsignedDisplay, Digits: 1},
		},
	}}
	layout := mustCompile(t, ast)

	// Zero occurrences do not read or expand V at all.
	zero := joinBytes(ascii("00"), ascii("7"))
	record, err := layout.Decode(zero, DecodeOptions{MaxLeaves: 2})
	if err != nil {
		t.Fatalf("zero-count record: %v", err)
	}
	if len(record.Find("V")) != 0 || record.First("TAIL").Start != 2 || record.Leaves != 2 {
		t.Fatalf("zero-count result = %#v", record)
	}

	two := joinBytes(ascii("02"), ascii("1111"), ascii("2222"), ascii("7"))
	record, err = layout.Decode(two, DecodeOptions{MaxLeaves: 3})
	if record != nil {
		t.Fatalf("leaf limit delivered a record")
	}
	var decodeErr *DecodeError
	if !errors.As(err, &decodeErr) || decodeErr.Code != ErrLeafLimit ||
		decodeErr.Path != "TAIL" || decodeErr.Offset != 10 {
		t.Fatalf("leaf-limit error = %v", err)
	}
	if record = mustDecode(t, layout, two, DecodeOptions{MaxLeaves: 4}); record.Leaves != 4 {
		t.Fatalf("leaves = %d, want 4", record.Leaves)
	}

	// Counts beyond the declared maximum fail before any item is read.
	tooMany := joinBytes(ascii("04"), ascii("1111"), ascii("7"))
	if record, err := layout.Decode(tooMany); record != nil || err == nil {
		t.Fatalf("out-of-range count decoded: %#v, %v", record, err)
	} else {
		var decodeErr *DecodeError
		if !errors.As(err, &decodeErr) || decodeErr.Code != ErrCount ||
			decodeErr.Path != "ARR" || decodeErr.Offset != 2 {
			t.Fatalf("count error = %v", err)
		}
	}
}

func TestRecordMustConsumeExactLength(t *testing.T) {
	ast := &AST{Root: &Node{Path: "ROOT", Kind: Group, Children: []*Node{
		{Path: "P", Kind: UnsignedDisplay, Digits: 2},
	}}}
	layout := mustCompile(t, ast)

	if record, err := layout.Decode([]byte("12")); err != nil || record.Size != 2 {
		t.Fatalf("exact record = %#v, %v", record, err)
	}
	if record, err := layout.Decode([]byte("123")); record != nil || err == nil {
		t.Fatalf("trailing byte decoded: %#v, %v", record, err)
	} else {
		var decodeErr *DecodeError
		if !errors.As(err, &decodeErr) || decodeErr.Code != ErrRecordSize || decodeErr.Offset != 2 {
			t.Fatalf("trailing error = %v", err)
		}
	}
	if record, err := layout.Decode([]byte("1")); record != nil || err == nil {
		t.Fatalf("short record decoded: %#v, %v", record, err)
	}
}

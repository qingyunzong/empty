package dataeng

import (
	"errors"
	"io"
	"math"
	"reflect"
	"testing"
)

func TestDirectRoundTrip(t *testing.T) {
	values := []Value{
		{Text: "Nevada"},
		{Text: "California"},
		{Null: true},
		{Text: ""},
		{Text: "Florida"},
	}
	for _, v2 := range []bool{false, true} {
		st := EncodeDirect(values, v2)
		decoder, err := NewStringDecoder(st)
		if err != nil {
			t.Fatalf("v2=%v: NewStringDecoder: %v", v2, err)
		}
		got, nulls, err := decoder.DecodeAllFromStart()
		if err != nil {
			t.Fatalf("v2=%v: DecodeAll: %v", v2, err)
		}
		wantValues, wantNulls := splitValues(values)
		if !reflect.DeepEqual(got, wantValues) || !reflect.DeepEqual(nulls, wantNulls) {
			t.Fatalf("v2=%v: got %q/%v, want %q/%v", v2, got, nulls, wantValues, wantNulls)
		}
	}
}

func TestDictionaryRoundTrip(t *testing.T) {
	values := []Value{
		{Text: "Nevada"},
		{Text: "California"},
		{Text: "Nevada"},
		{Null: true},
		{Text: "Florida"},
		{Text: ""},
	}
	for _, v2 := range []bool{false, true} {
		st := EncodeDictionary(values, v2)
		decoder, err := NewStringDecoder(st)
		if err != nil {
			t.Fatalf("v2=%v: NewStringDecoder: %v", v2, err)
		}
		got, nulls, err := decoder.DecodeAllFromStart()
		if err != nil {
			t.Fatalf("v2=%v: DecodeAll: %v", v2, err)
		}
		wantValues, wantNulls := splitValues(values)
		if !reflect.DeepEqual(got, wantValues) || !reflect.DeepEqual(nulls, wantNulls) {
			t.Fatalf("v2=%v: got %q/%v, want %q/%v", v2, got, nulls, wantValues, wantNulls)
		}
	}
}

func TestEncodingSwitchPreservesRows(t *testing.T) {
	first := []Value{{Text: "a"}, {Null: true}, {Text: "bb"}}
	second := []Value{{Text: "ccc"}, {Text: "d"}, {Null: true}}

	dictGroup := EncodeDictionary(first, false)
	directGroup := EncodeDirect(second, true)
	all := append(append([]Value{}, first...), second...)
	present, _ := presentFor(all)

	stripe := StringStream{
		Rows:    len(all),
		Present: present,
		RowGroups: []RowGroup{
			groupWithoutPresent(dictGroup),
			groupWithoutPresent(directGroup),
		},
	}
	decoder, err := NewStringDecoder(stripe)
	if err != nil {
		t.Fatalf("NewStringDecoder: %v", err)
	}
	if decoder.Rows() != 6 || decoder.RowGroups() != 2 {
		t.Fatalf("rows=%d groups=%d", decoder.Rows(), decoder.RowGroups())
	}
	got, nulls, err := decoder.DecodeAllFromStart()
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	wantValues, wantNulls := splitValues(all)
	if !reflect.DeepEqual(got, wantValues) || !reflect.DeepEqual(nulls, wantNulls) {
		t.Fatalf("got %q/%v, want %q/%v", got, nulls, wantValues, wantNulls)
	}
}

func TestRandomSeekMatchesSequential(t *testing.T) {
	values := make([]Value, 0, 300)
	for i := 0; i < 300; i++ {
		switch i % 7 {
		case 0:
			values = append(values, Value{Null: true})
		case 3:
			values = append(values, Value{Text: ""})
		default:
			values = append(values, Value{Text: string(rune('a' + i%26))})
		}
	}
	dict := EncodeDictionary(values[:150], true)
	direct := EncodeDirect(values[150:], false)
	present, _ := presentFor(values)
	stripe := StringStream{
		Rows:      300,
		Present:   present,
		RowGroups: []RowGroup{groupWithoutPresent(dict), groupWithoutPresent(direct)},
	}

	sequential, err := NewStringDecoder(stripe)
	if err != nil {
		t.Fatalf("NewStringDecoder: %v", err)
	}
	baseline, baselineNulls, err := sequential.DecodeAllFromStart()
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}

	random, err := NewStringDecoder(stripe)
	if err != nil {
		t.Fatalf("NewStringDecoder: %v", err)
	}
	order := []int{299, 0, 150, 149, 42, 42, 1, 298, 75, 200}
	for _, row := range order {
		if err := random.Seek(row); err != nil {
			t.Fatalf("Seek(%d): %v", row, err)
		}
		text, valid, err := random.Next()
		if err != nil {
			t.Fatalf("Next after Seek(%d): %v", row, err)
		}
		if text != baseline[row] || valid == baselineNulls[row] {
			t.Fatalf("row %d: got %q valid=%v, want %q valid=%v",
				row, text, valid, baseline[row], !baselineNulls[row])
		}
	}
	for row := 0; row < sequential.Rows(); row++ {
		if err := random.Seek(row); err != nil {
			t.Fatalf("Seek(%d): %v", row, err)
		}
		text, valid, err := random.Next()
		if err != nil {
			t.Fatalf("Next after Seek(%d): %v", row, err)
		}
		if text != baseline[row] || valid == baselineNulls[row] {
			t.Fatalf("all-seek row %d: got %q valid=%v, want %q valid=%v",
				row, text, valid, baseline[row], !baselineNulls[row])
		}
	}

	if err := random.Seek(0); err != nil {
		t.Fatal(err)
	}
	again, againNulls, err := random.DecodeAll()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(again, baseline) || !reflect.DeepEqual(againNulls, baselineNulls) {
		t.Fatal("seek changed the logical stream")
	}

	if _, _, err := random.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("Next at end: got %v, want EOF", err)
	}
}

func TestMissingStreamsOnlyValidForAllNull(t *testing.T) {
	for _, dictionary := range []bool{false, true} {
		var allNull StringStream
		if dictionary {
			allNull = EncodeDictionary([]Value{{Null: true}, {Null: true}}, false)
		} else {
			allNull = EncodeDirect([]Value{{Null: true}, {Null: true}}, false)
		}
		decoder, err := NewStringDecoder(allNull)
		if err != nil {
			t.Fatalf("dictionary=%v: all-null stream rejected: %v", dictionary, err)
		}
		_, nulls, err := decoder.DecodeAllFromStart()
		if err != nil {
			t.Fatalf("dictionary=%v: DecodeAll: %v", dictionary, err)
		}
		if !reflect.DeepEqual(nulls, []bool{true, true}) {
			t.Fatalf("dictionary=%v: nulls=%v", dictionary, nulls)
		}
	}

	missing := StringStream{
		Rows:     2,
		Encoding: EncodingDirect,
		Present:  EncodePresent([]bool{true, false}),
		Data:     []byte("x"),
	}
	if _, err := NewStringDecoder(missing); !errors.Is(err, ErrMissingStream) {
		t.Fatalf("missing LENGTH: got %v, want ErrMissingStream", err)
	}

	missingLengthData := StringStream{
		Rows:     2,
		Encoding: EncodingDirect,
		Present:  EncodePresent([]bool{true, false}),
	}
	if _, err := NewStringDecoder(missingLengthData); !errors.Is(err, ErrMissingStream) {
		t.Fatalf("missing DATA/LENGTH: got %v, want ErrMissingStream", err)
	}
}

func TestAbsentPresentMeansAllPresent(t *testing.T) {
	values := []Value{{Text: "one"}, {Text: "two"}}
	st := EncodeDirect(values, false)
	st.Present = nil
	decoder, err := NewStringDecoder(st)
	if err != nil {
		t.Fatalf("NewStringDecoder: %v", err)
	}
	got, _, err := decoder.DecodeAllFromStart()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"one", "two"}) {
		t.Fatalf("got %q", got)
	}
}

func TestDictionaryAlternateStreamLayout(t *testing.T) {
	dictionary := []string{"", "alpha", "beta"}
	dictLengths := []int64{0, 5, 4}
	indices := []int64{2, 1, 0, 2}
	stripe := StringStream{
		Rows:             4,
		Encoding:         EncodingDictionary,
		Data:             []byte("alphabeta"),
		DictionaryLength: EncodeRLEv1(dictLengths, false),
		Indices:          EncodeRLEv1(indices, false),
	}
	decoder, err := NewStringDecoder(stripe)
	if err != nil {
		t.Fatalf("NewStringDecoder: %v", err)
	}
	got, _, err := decoder.DecodeAllFromStart()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"beta", "alpha", "", "beta"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	_ = dictionary
}

func TestFlexibleConstructor(t *testing.T) {
	values := []Value{{Text: "x"}, {Null: true}, {Text: "yz"}}
	st := EncodeDirect(values, true)
	decoder, err := NewStringDecoder(len(values), EncodingDirectV2, Streams{
		Present: st.Present,
		Data:    st.Data,
		Length:  st.Length,
	})
	if err != nil {
		t.Fatalf("NewStringDecoder: %v", err)
	}
	got, nulls, err := decoder.DecodeAllFromStart()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"x", "", "yz"}) || !reflect.DeepEqual(nulls, []bool{false, true, false}) {
		t.Fatalf("got %q/%v", got, nulls)
	}
}

func TestSwitchEncodingPreservesPosition(t *testing.T) {
	first := EncodeDirect([]Value{{Text: "a"}, {Null: true}}, false)
	decoder, err := NewStringDecoder(first)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := decoder.Next(); err != nil {
		t.Fatal(err)
	}
	second := EncodeDictionary([]Value{{Text: "bb"}, {Text: "cc"}}, true)
	if err := decoder.SwitchEncoding(2, EncodingDictionaryV2, Streams{
		Data:             second.Data,
		Length:           second.Length,
		DictionaryData:   second.DictionaryData,
		DictionaryLength: second.DictionaryLength,
	}); err != nil {
		t.Fatal(err)
	}
	if decoder.Rows() != 4 || decoder.Row() != 1 || decoder.RowGroups() != 2 {
		t.Fatalf("rows=%d row=%d groups=%d", decoder.Rows(), decoder.Row(), decoder.RowGroups())
	}
	if err := decoder.Seek(2); err != nil {
		t.Fatal(err)
	}
	text, valid, err := decoder.Next()
	if err != nil || !valid || text != "bb" {
		t.Fatalf("got %q valid=%v err=%v", text, valid, err)
	}
	value, err := decoder.ValueAt(1)
	if err != nil || !value.Null {
		t.Fatalf("ValueAt(1)=%+v err=%v", value, err)
	}
}

func TestRLERoundTrips(t *testing.T) {
	unsigned := []int64{0, 1, 2, 1000, 127, 128, 255, 256, 65535, 1 << 20}
	for _, v2 := range []bool{false, true} {
		var encoded []byte
		if v2 {
			encoded = EncodeRLEv2(unsigned, false)
		} else {
			encoded = EncodeRLEv1(unsigned, false)
		}
		got, err := decodeInts(encoded, v2, false)
		if err != nil {
			t.Fatalf("v2=%v: %v", v2, err)
		}
		if !reflect.DeepEqual(got, unsigned) {
			t.Fatalf("v2=%v: got %v, want %v", v2, got, unsigned)
		}
	}

	signed := []int64{math.MinInt64 + 1, -1000, -1, 0, 1, 1000, math.MaxInt64}
	for _, v2 := range []bool{false, true} {
		var encoded []byte
		if v2 {
			encoded = EncodeRLEv2(signed, true)
		} else {
			encoded = EncodeRLEv1(signed, true)
		}
		got, err := decodeInts(encoded, v2, true)
		if err != nil {
			t.Fatalf("signed v2=%v: %v", v2, err)
		}
		if !reflect.DeepEqual(got, signed) {
			t.Fatalf("signed v2=%v: got %v, want %v", v2, got, signed)
		}
	}
}

func TestRLEv1KnownBytes(t *testing.T) {
	// [0x61, 0x00] is a run of 0x61+3 = 100 zeros, as used by the ORC spec.
	got, err := decodeInts([]byte{0x61, 0x00, 0x00}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 100 {
		t.Fatalf("got %d values", len(got))
	}
	for _, value := range got {
		if value != 0 {
			t.Fatalf("got %d", value)
		}
	}

	// 0xff means one literal, which is the unsigned varint 0x2a.
	got, err = decodeInts([]byte{0xff, 0x2a}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []int64{42}) {
		t.Fatalf("got %v", got)
	}
}

func TestRLEv2LongRuns(t *testing.T) {
	values := make([]int64, 1100)
	for i := range values {
		values[i] = int64((i * 37) % 1000)
	}
	encoded := EncodeRLEv2(values, false)
	got, err := decodeInts(encoded, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, values) {
		t.Fatalf("long RLEv2 round trip differs at %d", firstDifference(got, values))
	}
}

func TestRLEv2DeltaFixture(t *testing.T) {
	// The ORC specification example: [2,3,5,7,11,13,17,19,23,29].
	encoded := []byte{
		0xc6, 0x09, // delta, width 4, length 10
		0x02,                   // base 2
		0x02,                   // first delta 1 (signed varint)
		0x22, 0x42, 0x42, 0x46, // remaining deltas at 4 bits
	}
	got, err := decodeInts(encoded, true, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{2, 3, 5, 7, 11, 13, 17, 19, 23, 29}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRLEv2FixedDeltaFixture(t *testing.T) {
	encoded := []byte{
		0xc0, 0x04, // delta, width 0 (constant delta), length 5
		0x0a, // base 10
		0x06, // delta base 3 (signed varint)
	}
	got, err := decodeInts(encoded, true, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{10, 13, 16, 19, 22}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRLEv2PatchedBaseFixture(t *testing.T) {
	encoded := []byte{
		0x84, 0x03, // patched base, width 3, length 4
		0x01,       // base width 1, patch width 2
		0x23,       // gap width 2, 3 patches
		0x64,       // base 100
		0x0a, 0x60, // offsets [0,2,4,6]
		0x52, 0x30, // (gap 1,patch 1), (gap 0,patch 2), (gap 0,patch 3)
	}
	got, err := decodeInts(encoded, true, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []int64{100, 110, 120, 130}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestTruncatedStreamsRejected(t *testing.T) {
	st := EncodeDirect([]Value{{Text: "hello"}}, false)
	st.Length = st.Length[:len(st.Length)-1]
	if _, err := NewStringDecoder(st); err == nil {
		t.Fatal("truncated LENGTH accepted")
	}

	present := EncodePresent([]bool{true, true, true})
	if _, err := NewStringDecoder(StringStream{
		Rows:     9,
		Encoding: EncodingDirect,
		Present:  present,
	}); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("truncated PRESENT: got %v, want ErrCorrupt", err)
	}
}

func splitValues(values []Value) ([]string, []bool) {
	text := make([]string, len(values))
	nulls := make([]bool, len(values))
	for i, value := range values {
		text[i] = value.Text
		nulls[i] = value.Null
	}
	return text, nulls
}

func groupWithoutPresent(st StringStream) RowGroup {
	return RowGroup{
		Rows:             st.Rows,
		Encoding:         st.Encoding,
		Data:             st.Data,
		Length:           st.Length,
		DictionaryData:   st.DictionaryData,
		DictionaryLength: st.DictionaryLength,
		Indices:          st.Indices,
	}
}

func firstDifference(a, b []int64) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return i
		}
	}
	if len(a) != len(b) {
		return min(len(a), len(b))
	}
	return -1
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

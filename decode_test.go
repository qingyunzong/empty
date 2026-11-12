package dataeng_test

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	dataeng "example.org/dataeng/q0337"
)

// The helpers in this file deliberately encode bytes directly. They do not
// call the package under test, and expected Binding values are literals.

func appendBytes(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func testLength(n int) []byte {
	if n < 0x80 {
		return []byte{byte(n)}
	}

	var raw []byte
	for value := n; value > 0; value >>= 8 {
		raw = append([]byte{byte(value)}, raw...)
	}
	if len(raw) > 4 {
		panic("test length needs more than four octets")
	}
	return append([]byte{0x80 | byte(len(raw))}, raw...)
}

func testTLV(tag byte, content []byte) []byte {
	return append(append([]byte{tag}, testLength(len(content))...), content...)
}

func testSignedInteger(value int64) []byte {
	encoded := []byte{byte(value)}
	for {
		value >>= 8
		if value == 0 && encoded[0]&0x80 == 0 {
			return encoded
		}
		if value == -1 && encoded[0]&0x80 != 0 {
			return encoded
		}
		encoded = append([]byte{byte(value)}, encoded...)
	}
}

func testOIDContent(arcs ...int) []byte {
	if len(arcs) < 2 {
		panic("test OID needs two arcs")
	}

	encoded := []byte{byte(arcs[0]*40 + arcs[1])}
	for _, arc := range arcs[2:] {
		groups := []byte{}
		for {
			groups = append([]byte{byte(arc & 0x7f)}, groups...)
			arc >>= 7
			if arc == 0 {
				break
			}
		}
		for i := 0; i < len(groups)-1; i++ {
			groups[i] |= 0x80
		}
		encoded = append(encoded, groups...)
	}
	return encoded
}

func testOID(arcs ...int) []byte {
	return testTLV(0x06, testOIDContent(arcs...))
}

func testApplication(tag byte, value uint32) []byte {
	encoded := []byte{byte(value)}
	for value >>= 8; value > 0; value >>= 8 {
		encoded = append([]byte{byte(value)}, encoded...)
	}
	return testTLV(0x40|tag, encoded)
}

func testBinding(oid, value []byte) []byte {
	return testTLV(0x30, appendBytes(oid, value))
}

func testMessage(version int, community []byte, requestID int64, status, index int, bindings ...[]byte) []byte {
	bindingList := appendBytes(bindings...)
	response := appendBytes(
		testTLV(0x02, testSignedInteger(requestID)),
		testTLV(0x02, testSignedInteger(int64(status))),
		testTLV(0x02, testSignedInteger(int64(index))),
		testTLV(0x30, bindingList),
	)
	return testTLV(0x30, appendBytes(
		testTLV(0x02, testSignedInteger(int64(version))),
		testTLV(0x04, community),
		testTLV(0xa2, response),
	))
}

func expectDecodeError(t *testing.T, message []byte, maxMessage int) {
	t.Helper()

	got, err := dataeng.Decode(message, maxMessage)
	if err == nil {
		t.Fatalf("Decode succeeded, want error; got %#v", got)
	}
	if got != nil {
		t.Fatalf("Decode returned a partial message %#v with error %v", got, err)
	}
}

func TestDecodeValidResponse(t *testing.T) {
	longOctets := bytes.Repeat([]byte{0xa5}, 128)

	message := testMessage(
		1,
		[]byte("public"),
		0x01020304,
		0,
		0,
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 0), testTLV(0x04, []byte("ok"))),
		testBinding(testOID(1, 3, 6, 1, 2, 1, 1, 0), testTLV(0x02, testSignedInteger(-1))),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 2), testTLV(0x05, nil)),
		testBinding(testOID(2, 1), testOID(1, 3, 6, 1, 4, 1, 42, 1)),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 3), testApplication(1, 4294967295)),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 4), testApplication(2, 0)),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 5), testApplication(3, 12345)),
		testBinding(testOID(2, 175, 3), testTLV(0x04, longOctets)),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 6), testTLV(0x02, []byte{0x00, 0xff})),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 7), testTLV(0x02, []byte{0xff, 0x7f})),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 9999, 0), testTLV(0x05, nil)),
	)

	got, err := dataeng.Decode(message, 1<<20)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}

	want := &dataeng.Message{
		Version:     1,
		Community:   []byte("public"),
		RequestID:   0x01020304,
		ErrorStatus: 0,
		ErrorIndex:  0,
		Bindings: []dataeng.Binding{
			{
				OID:   dataeng.OID{1, 3, 6, 1, 4, 1, 42, 0},
				Value: dataeng.Value{Type: dataeng.ValueOctetString, Octets: []byte("ok")},
			},
			{
				OID:   dataeng.OID{1, 3, 6, 1, 2, 1, 1, 0},
				Value: dataeng.Value{Type: dataeng.ValueInteger, Integer: -1},
			},
			{
				OID:   dataeng.OID{1, 3, 6, 1, 4, 1, 42, 2},
				Value: dataeng.Value{Type: dataeng.ValueNull},
			},
			{
				OID:   dataeng.OID{2, 1},
				Value: dataeng.Value{Type: dataeng.ValueOID, OID: dataeng.OID{1, 3, 6, 1, 4, 1, 42, 1}},
			},
			{
				OID: dataeng.OID{1, 3, 6, 1, 4, 1, 42, 3},
				Value: dataeng.Value{
					Type:     dataeng.ValueApplication,
					Tag:      dataeng.ApplicationCounter32,
					Unsigned: 4294967295,
				},
			},
			{
				OID: dataeng.OID{1, 3, 6, 1, 4, 1, 42, 4},
				Value: dataeng.Value{
					Type:     dataeng.ValueApplication,
					Tag:      dataeng.ApplicationGauge32,
					Unsigned: 0,
				},
			},
			{
				OID: dataeng.OID{1, 3, 6, 1, 4, 1, 42, 5},
				Value: dataeng.Value{
					Type:     dataeng.ValueApplication,
					Tag:      dataeng.ApplicationTimeTicks,
					Unsigned: 12345,
				},
			},
			{
				OID:   dataeng.OID{2, 175, 3},
				Value: dataeng.Value{Type: dataeng.ValueOctetString, Octets: longOctets},
			},
			{
				OID:   dataeng.OID{1, 3, 6, 1, 4, 1, 42, 6},
				Value: dataeng.Value{Type: dataeng.ValueInteger, Integer: 255},
			},
			{
				OID:   dataeng.OID{1, 3, 6, 1, 4, 1, 42, 7},
				Value: dataeng.Value{Type: dataeng.ValueInteger, Integer: -129},
			},
			{
				OID:   dataeng.OID{1, 3, 6, 1, 4, 1, 9999, 0},
				Value: dataeng.Value{Type: dataeng.ValueNull},
			},
		},
	}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Decode mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDecodeVersionZeroAndEmptyBindings(t *testing.T) {
	message := testMessage(0, []byte("private"), 7, 5, 7)
	got, err := dataeng.Decode(message, 4096)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := &dataeng.Message{
		Version:     0,
		Community:   []byte("private"),
		RequestID:   7,
		ErrorStatus: 5,
		ErrorIndex:  7,
		Bindings:    nil,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Decode mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestDecodeOIDFirstOctet(t *testing.T) {
	message := testMessage(
		1,
		[]byte("public"),
		1,
		0,
		0,
		testBinding(testOID(0, 39, 1), testTLV(0x05, nil)),
		testBinding(testOID(1, 0, 2), testTLV(0x05, nil)),
		testBinding(testOID(2, 175, 3), testTLV(0x05, nil)),
	)

	got, err := dataeng.Decode(message, 4096)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	wantOIDs := []dataeng.OID{
		{0, 39, 1},
		{1, 0, 2},
		{2, 175, 3},
	}
	for i, wantOID := range wantOIDs {
		if !reflect.DeepEqual(got.Bindings[i].OID, wantOID) {
			t.Fatalf("binding %d OID = %v, want %v", i, got.Bindings[i].OID, wantOID)
		}
	}
}

func TestRejectsNonMinimalLongFormLength(t *testing.T) {
	// The first value declares length 128 with 0x82 0x00 0x80. It is
	// numerically correct but has an extra leading zero length octet.
	badValue := append([]byte{0x04, 0x82, 0x00, 0x80}, bytes.Repeat([]byte{0x5a}, 128)...)
	message := testMessage(
		1,
		[]byte("public"),
		1,
		0,
		0,
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 0), badValue),
	)
	expectDecodeError(t, message, 4096)
}

func TestRejectsLengthThatSwallowsNextBinding(t *testing.T) {
	// A length with an extra leading zero claims all eight bytes of the
	// following binding as the first value. A lax decoder would return one
	// successful binding and lose the second; the strict decoder rejects the
	// non-minimal length before reading those bytes.
	nextBinding := testTLV(0x30, appendBytes(
		testOID(1, 3, 6),
		testTLV(0x05, nil),
	))
	badValue := append([]byte{0x04, 0x82, 0x00, byte(len(nextBinding))}, nextBinding...)
	firstBinding := testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 0), badValue)

	message := testMessage(1, []byte("public"), 1, 0, 0, firstBinding)
	expectDecodeError(t, message, 4096)
}

func TestRejectsInvalidLengthForms(t *testing.T) {
	tests := []struct {
		name  string
		value []byte
	}{
		{
			name:  "indefinite 0x80",
			value: []byte{0x04, 0x80, 0x00},
		},
		{
			name:  "long form for short length",
			value: []byte{0x04, 0x81, 0x05, 1, 2, 3, 4, 5},
		},
		{
			name:  "leading zero single length octet",
			value: []byte{0x04, 0x81, 0x00},
		},
		{
			name:  "unsupported length octet count",
			value: []byte{0x04, 0x85, 0x00, 0x00, 0x00, 0x00, 0x01},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := testMessage(
				1,
				[]byte("public"),
				1,
				0,
				0,
				testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 0), test.value),
			)
			expectDecodeError(t, message, 4096)
		})
	}
}

func TestRejectsNonMinimalInteger(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
	}{
		{name: "empty", content: nil},
		{name: "zero redundant 00", content: []byte{0x00, 0x00}},
		{name: "positive redundant 00", content: []byte{0x00, 0x7f}},
		{name: "negative redundant ff", content: []byte{0xff, 0x80}},
		{name: "minus one redundant ff", content: []byte{0xff, 0xff}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := testMessage(
				1,
				[]byte("public"),
				1,
				0,
				0,
				testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 0), testTLV(0x02, test.content)),
			)
			expectDecodeError(t, message, 4096)
		})
	}
}

func TestDecodeRequiredIntegerSignOctets(t *testing.T) {
	message := testMessage(
		1,
		[]byte("public"),
		1,
		0,
		0,
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 0), testTLV(0x02, []byte{0x00})),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 1), testTLV(0x02, []byte{0x7f})),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 2), testTLV(0x02, []byte{0x80})),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 3), testTLV(0x02, []byte{0x00, 0x80})),
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 4), testTLV(0x02, []byte{0xff, 0x00})),
	)

	got, err := dataeng.Decode(message, 4096)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	wantIntegers := []int64{0, 127, -128, 128, -256}
	for i, want := range wantIntegers {
		if got.Bindings[i].Value.Integer != want {
			t.Fatalf("binding %d INTEGER = %d, want %d", i, got.Bindings[i].Value.Integer, want)
		}
	}
}

func TestRejectsInvalidOIDEncoding(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
	}{
		{name: "empty", content: nil},
		{name: "unterminated arc", content: []byte{0x2b, 0x81}},
		{name: "non-minimal arc leading zero group", content: []byte{0x2b, 0x80, 0x00}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := testMessage(
				1,
				[]byte("public"),
				1,
				0,
				0,
				testBinding(testTLV(0x06, test.content), testTLV(0x05, nil)),
			)
			expectDecodeError(t, message, 4096)
		})
	}
}

func TestRejectsInvalidErrorStatusAndIndex(t *testing.T) {
	tests := []struct {
		name   string
		status int
		index  int
	}{
		{name: "status six", status: 6, index: 0},
		{name: "negative status", status: -1, index: 0},
		{name: "negative index", status: 1, index: -1},
		{name: "index without error", status: 0, index: 1},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := testMessage(1, []byte("public"), 1, test.status, test.index)
			expectDecodeError(t, message, 4096)
		})
	}
}

func TestRejectsNullWithContent(t *testing.T) {
	message := testMessage(
		1,
		[]byte("public"),
		1,
		0,
		0,
		testBinding(testOID(1, 3, 6, 1, 4, 1, 42, 0), testTLV(0x05, []byte{0x00})),
	)
	expectDecodeError(t, message, 4096)
}

func TestRejectsInvalidApplicationInteger(t *testing.T) {
	tests := []struct {
		name    string
		tag     byte
		content []byte
	}{
		{name: "empty", tag: 1, content: nil},
		{name: "five bytes above host range", tag: 1, content: []byte{0x01, 0x00, 0x00, 0x00, 0x00}},
		{name: "five bytes with leading zero", tag: 2, content: []byte{0x00, 0xff, 0xff, 0xff, 0xff}},
		{name: "four bytes with leading zero", tag: 3, content: []byte{0x00, 0x00, 0x00, 0x01}},
		{name: "six bytes", tag: 1, content: []byte{0x01, 0x00, 0x00, 0x00, 0x00, 0x00}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := testMessage(
				1,
				[]byte("public"),
				1,
				0,
				0,
				testBinding(
					testOID(1, 3, 6, 1, 4, 1, 42, 0),
					testTLV(0x40|test.tag, test.content),
				),
			)
			expectDecodeError(t, message, 4096)
		})
	}
}

func TestRejectsDeclaredLengthAboveMaxMessage(t *testing.T) {
	// The 0x84 length declares 0x7fffffff bytes while no content follows. The
	// host limit must reject it from the header alone, before any allocation.
	message := []byte{0x30, 0x84, 0x7f, 0xff, 0xff, 0xff}

	got, err := dataeng.Decode(message, 1024)
	if err == nil {
		t.Fatalf("Decode succeeded, want too-large error; got %#v", got)
	}
	if got != nil {
		t.Fatalf("Decode returned a partial message %#v with error %v", got, err)
	}
	if !errors.Is(err, dataeng.ErrMessageTooLarge) {
		t.Fatalf("error %v does not wrap ErrMessageTooLarge", err)
	}
}

func TestRejectsShortLengthAboveMaxMessage(t *testing.T) {
	message := testMessage(
		1,
		[]byte("public"),
		1,
		0,
		0,
		testBinding(
			testOID(1, 3, 6, 1, 4, 1, 42, 0),
			testTLV(0x04, bytes.Repeat([]byte{0x11}, 40)),
		),
	)

	got, err := dataeng.Decode(message, 10)
	if err == nil {
		t.Fatalf("Decode succeeded, want too-large error; got %#v", got)
	}
	if got != nil {
		t.Fatalf("Decode returned a partial message %#v with error %v", got, err)
	}
	if !errors.Is(err, dataeng.ErrMessageTooLarge) {
		t.Fatalf("error %v does not wrap ErrMessageTooLarge", err)
	}
}

func TestRejectsTrailingBytesAndWrongOuterType(t *testing.T) {
	message := testMessage(1, []byte("public"), 1, 0, 0)
	expectDecodeError(t, append(message, 0x00), 4096)

	wrongOuter := append([]byte{}, message...)
	wrongOuter[0] = 0x31
	expectDecodeError(t, wrongOuter, 4096)
}

func TestRejectsWrongVersionAndResponseTag(t *testing.T) {
	expectDecodeError(t, testMessage(2, []byte("public"), 1, 0, 0), 4096)

	response := appendBytes(
		testTLV(0x02, testSignedInteger(1)),
		testTLV(0x02, testSignedInteger(0)),
		testTLV(0x02, testSignedInteger(0)),
		testTLV(0x30, nil),
	)
	message := testTLV(0x30, appendBytes(
		testTLV(0x02, testSignedInteger(1)),
		testTLV(0x04, []byte("public")),
		testTLV(0xa3, response),
	))
	expectDecodeError(t, message, 4096)
}

func TestRejectsBindingWithExtraContent(t *testing.T) {
	bindingContent := appendBytes(
		testOID(1, 3, 6, 1, 4, 1, 42, 0),
		testTLV(0x05, nil),
		[]byte{0x00},
	)
	message := testMessage(
		1,
		[]byte("public"),
		1,
		0,
		0,
		testTLV(0x30, bindingContent),
	)
	expectDecodeError(t, message, 4096)
}

func TestRejectsInvalidLongFormTag(t *testing.T) {
	tests := []struct {
		name    string
		message []byte
	}{
		{
			name:    "truncated after tag marker",
			message: []byte{0x3f},
		},
		{
			name:    "truncated continuation",
			message: []byte{0x3f, 0x81},
		},
		{
			name:    "leading zero group",
			message: []byte{0x3f, 0x80, 0x10, 0x00, 0x00},
		},
		{
			name:    "long form for short tag",
			message: []byte{0x3f, 0x10, 0x00},
		},
		{
			name:    "valid long tag but not a sequence",
			message: []byte{0x3f, 0x81, 0x00, 0x00},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			expectDecodeError(t, test.message, 4096)
		})
	}
}

func TestDecodeMessageAlias(t *testing.T) {
	message := testMessage(1, []byte("public"), 1, 0, 0)
	got, err := dataeng.DecodeMessage(message, 4096)
	if err != nil {
		t.Fatalf("DecodeMessage: %v", err)
	}
	if got == nil || got.Version != 1 {
		t.Fatalf("DecodeMessage returned %#v", got)
	}
}

func FuzzDecode(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{0x30, 0x00})
	f.Add([]byte{0x30, 0x80})
	f.Add(testMessage(1, []byte("public"), 1, 0, 0))

	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := dataeng.Decode(data, 4096)
		if err != nil && got != nil {
			t.Fatalf("Decode returned a partial message %#v with error %v", got, err)
		}
	})
}

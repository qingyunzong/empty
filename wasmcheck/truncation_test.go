package wasmcheck

import "testing"

func TestTruncatedSectionPayloads(t *testing.T) {
	cases := []struct {
		name string
		id   byte
		body []byte
	}{
		{
			name: "import truncated in module name",
			id:   sectionImport,
			body: []byte{0x01, 0x03, 'e'},
		},
		{
			name: "import truncated before kind",
			id:   sectionImport,
			body: concat(
				[]byte{0x01},
				appendName(nil, "env"),
				appendName(nil, "f"),
			),
		},
		{
			name: "import truncated type index",
			id:   sectionImport,
			body: concat(
				[]byte{0x01},
				appendName(nil, "env"),
				appendName(nil, "f"),
				[]byte{kindFunction, 0x80},
			),
		},
		{
			name: "function section truncated type index",
			id:   sectionFunction,
			body: []byte{0x01, 0x80},
		},
		{
			name: "table section truncated element type",
			id:   sectionTable,
			body: []byte{0x01},
		},
		{
			name: "table section truncated limits flag",
			id:   sectionTable,
			body: []byte{0x01, funcrefType},
		},
		{
			name: "table section truncated min",
			id:   sectionTable,
			body: []byte{0x01, funcrefType, 0x00, 0x80},
		},
		{
			name: "table section truncated max",
			id:   sectionTable,
			body: concat(
				[]byte{0x01, funcrefType, 0x01},
				appendU32LEB(nil, 2),
				[]byte{0x80},
			),
		},
		{
			name: "export truncated name",
			id:   sectionExport,
			body: []byte{0x01, 0x02, 'a'},
		},
		{
			name: "export truncated kind",
			id:   sectionExport,
			body: concat([]byte{0x01}, appendName(nil, "e")),
		},
		{
			name: "export truncated index",
			id:   sectionExport,
			body: concat(
				[]byte{0x01},
				appendName(nil, "e"),
				[]byte{kindFunction, 0x80},
			),
		},
		{
			name: "element truncated flags",
			id:   sectionElement,
			body: []byte{0x01},
		},
		{
			name: "element truncated table index",
			id:   sectionElement,
			body: []byte{0x01, 0x02, 0x80},
		},
		{
			name: "element truncated offset value",
			id:   sectionElement,
			body: []byte{0x01, 0x00, valTypeI32, 0x80},
		},
		{
			name: "element truncated ref count",
			id:   sectionElement,
			body: []byte{0x01, 0x00, valTypeI32, 0x00, 0x0b, 0x80},
		},
		{
			name: "element truncated ref value",
			id:   sectionElement,
			body: concat(
				[]byte{0x01, 0x00, valTypeI32},
				appendS32LEB(nil, 0),
				[]byte{0x0b},
				appendU32LEB(nil, 1),
				[]byte{0x80},
			),
		},
		{
			name: "type section truncated marker",
			id:   sectionType,
			body: []byte{0x01},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bin := encodeModule(encodeRawSection(tc.id, tc.body))
			if _, err := Inspect(bin, nil); err == nil {
				t.Fatal("expected malformed/truncated section error")
			}
		})
	}
}

func TestSectionLengthLEBTruncated(t *testing.T) {
	// Header followed by a section id whose length LEB is cut short.
	bin := []byte{0x00, 'a', 's', 'm', 0x01, 0x00, 0x00, 0x00, sectionType, 0x80}
	if _, err := Inspect(bin, nil); err == nil {
		t.Fatal("expected truncated section-length error")
	}
}

func TestEmptyCustomPayloadRejected(t *testing.T) {
	bin := encodeModule(encodeRawSection(sectionCustom, nil))
	if _, err := Inspect(bin, nil); err == nil {
		t.Fatal("expected error for custom section without a name")
	}
}

func TestInvalidUTF8NameRejected(t *testing.T) {
	body := concat([]byte{0x01}, appendName(nil, "env"), []byte{0x02, 0xff, 0xfe}, []byte{kindFunction}, appendU32LEB(nil, 0))
	types := []FuncType{{Params: nil, Results: nil}}
	bin := encodeModule(
		encodeTypeSection(types),
		encodeRawSection(sectionImport, body),
	)
	if _, err := Inspect(bin, nil); err == nil {
		t.Fatal("expected invalid UTF-8 error")
	}
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

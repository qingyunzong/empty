package wasmcheck

// This file is a deliberately small, self-contained WebAssembly binary
// encoder used only by the tests. It is independent of the parser under test,
// so shared encoder bugs cannot mask parser bugs.

func appendU32LEB(buf []byte, v uint32) []byte {
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		buf = append(buf, b)
		if v == 0 {
			return buf
		}
	}
}

func appendS32LEB(buf []byte, v int32) []byte {
	value := int64(v)
	more := true
	for more {
		b := byte(value & 0x7f)
		next := value >> 7
		signBit := b & 0x40
		if (next == 0 && signBit == 0) || (next == -1 && signBit != 0) {
			more = false
		} else {
			b |= 0x80
			value = next
		}
		buf = append(buf, b)
	}
	return buf
}

func appendName(buf []byte, name string) []byte {
	buf = appendU32LEB(buf, uint32(len(name)))
	return append(buf, name...)
}

func wrapSection(id byte, body []byte) []byte {
	out := []byte{id}
	out = appendU32LEB(out, uint32(len(body)))
	return append(out, body...)
}

func encodeTypeSection(types []FuncType) []byte {
	var body []byte
	body = appendU32LEB(body, uint32(len(types)))
	for _, t := range types {
		body = append(body, funcTypeMarker)
		body = appendU32LEB(body, uint32(len(t.Params)))
		body = append(body, t.Params...)
		body = appendU32LEB(body, uint32(len(t.Results)))
		body = append(body, t.Results...)
	}
	return wrapSection(sectionType, body)
}

type testImport struct {
	module    string
	field     string
	kind      byte
	typeIndex uint32
}

func encodeImportSection(imports []testImport) []byte {
	var body []byte
	body = appendU32LEB(body, uint32(len(imports)))
	for _, imp := range imports {
		body = appendName(body, imp.module)
		body = appendName(body, imp.field)
		body = append(body, imp.kind)
		body = appendU32LEB(body, imp.typeIndex)
	}
	return wrapSection(sectionImport, body)
}

func encodeFunctionSection(typeIndices []uint32) []byte {
	var body []byte
	body = appendU32LEB(body, uint32(len(typeIndices)))
	for _, idx := range typeIndices {
		body = appendU32LEB(body, idx)
	}
	return wrapSection(sectionFunction, body)
}

type testTable struct {
	elemType byte
	min      uint32
	max      uint32
	hasMax   bool
}

func encodeTableSection(tables []testTable) []byte {
	var body []byte
	body = appendU32LEB(body, uint32(len(tables)))
	for _, t := range tables {
		body = append(body, t.elemType)
		if t.hasMax {
			body = append(body, 0x01)
			body = appendU32LEB(body, t.min)
			body = appendU32LEB(body, t.max)
		} else {
			body = append(body, 0x00)
			body = appendU32LEB(body, t.min)
		}
	}
	return wrapSection(sectionTable, body)
}

type testExport struct {
	name  string
	kind  byte
	index uint32
}

func encodeExportSection(exports []testExport) []byte {
	var body []byte
	body = appendU32LEB(body, uint32(len(exports)))
	for _, e := range exports {
		body = appendName(body, e.name)
		body = append(body, e.kind)
		body = appendU32LEB(body, e.index)
	}
	return wrapSection(sectionExport, body)
}

type testElement struct {
	flags      byte
	tableIndex uint32
	offset     int32
	funcs      []uint32
}

func encodeElementSection(segments []testElement) []byte {
	var body []byte
	body = appendU32LEB(body, uint32(len(segments)))
	for _, seg := range segments {
		body = append(body, seg.flags)
		if seg.flags == 0x02 {
			body = appendU32LEB(body, seg.tableIndex)
		}
		body = append(body, valTypeI32)
		body = appendS32LEB(body, seg.offset)
		body = append(body, 0x0b)
		body = appendU32LEB(body, uint32(len(seg.funcs)))
		for _, f := range seg.funcs {
			body = appendU32LEB(body, f)
		}
	}
	return wrapSection(sectionElement, body)
}

func encodeCustomSection(name string, data []byte) []byte {
	var body []byte
	body = appendName(body, name)
	body = append(body, data...)
	return wrapSection(sectionCustom, body)
}

func encodeRawSection(id byte, body []byte) []byte {
	return wrapSection(id, body)
}

func encodeModule(sections ...[]byte) []byte {
	var bin []byte
	bin = append(bin, wasmMagic...)
	// The version is a fixed little-endian 32-bit integer.
	bin = append(bin, wasmVersion, 0x00, 0x00, 0x00)
	for _, sec := range sections {
		bin = append(bin, sec...)
	}
	return bin
}

func encodeCodeSection(bodyCount int) []byte {
	// Bodies are not semantically inspected; emit empty-body functions with
	// declared lengths kept consistent with the section length.
	var body []byte
	body = appendU32LEB(body, uint32(bodyCount))
	for i := 0; i < bodyCount; i++ {
		body = appendU32LEB(body, 2)
		body = append(body, 0x00, 0x0b)
	}
	return wrapSection(sectionCode, body)
}

// validModule returns a well-formed module used as the baseline for the
// success cases and the mutation tests.
func validModule() ([]byte, []AllowedImport) {
	types := []FuncType{
		{Params: []byte{valTypeI32}, Results: []byte{valTypeI32}},
		{Params: nil, Results: []byte{valTypeI64}},
		{Params: []byte{valTypeI64, valTypeF32}, Results: nil},
	}
	allowed := []AllowedImport{
		{Module: "env", Field: "increment", FuncType: types[0]},
		{Module: "env", Field: "now", FuncType: types[1]},
	}
	bin := encodeModule(
		encodeTypeSection(types),
		encodeImportSection([]testImport{
			{module: "env", field: "increment", kind: kindFunction, typeIndex: 0},
			{module: "env", field: "now", kind: kindFunction, typeIndex: 1},
		}),
		encodeFunctionSection([]uint32{2, 0}),
		encodeTableSection([]testTable{
			{elemType: funcrefType, min: 4, max: 8, hasMax: true},
		}),
		encodeExportSection([]testExport{
			{name: "worker", kind: kindFunction, index: 2},
			{name: "helper", kind: kindFunction, index: 3},
			{name: "table0", kind: kindTable, index: 0},
		}),
		encodeElementSection([]testElement{
			{flags: 0x00, offset: 0, funcs: []uint32{2, 3, 0}},
		}),
		encodeCodeSection(2),
	)
	return bin, allowed
}

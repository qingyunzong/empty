package wasmcheck

import (
	"strings"
	"testing"
)

func TestTypeSectionMalformed(t *testing.T) {
	cases := map[string][]byte{
		"bad function marker":      {0x01, 0x61},
		"invalid parameter type":   {0x01, funcTypeMarker, 0x01, 0x6e},
		"invalid result type":      {0x01, funcTypeMarker, 0x00, 0x01, 0x6b},
		"truncated vector":         {0x02},
		"parameter count past end": {0x01, funcTypeMarker, 0x03, valTypeI32},
		"result count past end":    {0x01, funcTypeMarker, 0x00, 0x02, valTypeI32},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			bin := encodeModule(encodeRawSection(sectionType, body))
			if _, err := Inspect(bin, nil); err == nil {
				t.Fatal("expected malformed type section error")
			}
		})
	}
}

func TestImportEdgeCases(t *testing.T) {
	t.Run("empty field name rejected", func(t *testing.T) {
		var body []byte
		body = appendU32LEB(body, 1)
		body = appendName(body, "env")
		body = appendName(body, "")
		body = append(body, kindFunction)
		body = appendU32LEB(body, 0)
		types := []FuncType{{Params: nil, Results: nil}}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeRawSection(sectionImport, body),
		)
		if _, err := Inspect(bin, []AllowedImport{{Module: "env", Field: "", FuncType: types[0]}}); err == nil ||
			!strings.Contains(err.Error(), "empty module or field") {
			t.Fatalf("expected empty-name error, got %v", err)
		}
	})

	t.Run("result arity mismatch rejected", func(t *testing.T) {
		types := []FuncType{{Params: []byte{valTypeI32}, Results: nil}}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeImportSection([]testImport{
				{module: "env", field: "f", kind: kindFunction, typeIndex: 0},
			}),
		)
		want := FuncType{Params: []byte{valTypeI32}, Results: []byte{valTypeI32}}
		if _, err := Inspect(bin, []AllowedImport{{Module: "env", Field: "f", FuncType: want}}); err == nil ||
			!strings.Contains(err.Error(), "signature does not match") {
			t.Fatalf("expected signature error, got %v", err)
		}
	})

	t.Run("duplicate import rejected", func(t *testing.T) {
		types := []FuncType{{Params: nil, Results: nil}}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeImportSection([]testImport{
				{module: "env", field: "f", kind: kindFunction, typeIndex: 0},
				{module: "env", field: "f", kind: kindFunction, typeIndex: 0},
			}),
		)
		allowed := []AllowedImport{{Module: "env", Field: "f", FuncType: types[0]}}
		if _, err := Inspect(bin, allowed); err == nil ||
			!strings.Contains(err.Error(), "duplicate import") {
			t.Fatalf("expected duplicate import error, got %v", err)
		}
	})
}

func TestElementOffsetMalformed(t *testing.T) {
	types := []FuncType{{Params: nil, Results: nil}}

	t.Run("wrong offset opcode rejected", func(t *testing.T) {
		var body []byte
		body = appendU32LEB(body, 1)
		body = append(body, 0x00)
		body = append(body, valTypeI64) // must be i32.const (0x41); 0x7e is a type byte
		body = appendS32LEB(body, 0)
		body = append(body, 0x0b)
		body = appendU32LEB(body, 0)
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{0}),
			encodeTableSection([]testTable{{elemType: funcrefType, min: 1}}),
			encodeRawSection(sectionElement, body),
			encodeCodeSection(1),
		)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "i32.const") {
			t.Fatalf("expected opcode error, got %v", err)
		}
	})

	t.Run("missing end byte rejected", func(t *testing.T) {
		var body []byte
		body = appendU32LEB(body, 1)
		body = append(body, 0x00, valTypeI32)
		body = appendS32LEB(body, 1)
		body = append(body, 0x00) // not 0x0b
		body = appendU32LEB(body, 0)
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{0}),
			encodeTableSection([]testTable{{elemType: funcrefType, min: 1}}),
			encodeRawSection(sectionElement, body),
			encodeCodeSection(1),
		)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "must end with 0x0b") {
			t.Fatalf("expected end-byte error, got %v", err)
		}
	})
}

func TestExportAndTableAccessors(t *testing.T) {
	bin, allowed := validModule()
	caps, err := Inspect(bin, allowed)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if caps.ImportCount() != 2 {
		t.Fatalf("ImportCount = %d, want 2", caps.ImportCount())
	}
	exp := caps.Export(0)
	if exp.Name != "worker" {
		t.Fatalf("Export(0).Name = %q", exp.Name)
	}
	if _, ok := caps.ExportByName("missing"); ok {
		t.Fatal("missing export unexpectedly found")
	}
	if caps.Table(0).Min != 4 {
		t.Fatal("Table(0) accessor returned wrong min")
	}
}

func TestLoadNilCallback(t *testing.T) {
	bin, allowed := validModule()
	if _, err := Load(bin, allowed, nil); err == nil ||
		!strings.Contains(err.Error(), "callback is nil") {
		t.Fatalf("expected nil-callback error, got %v", err)
	}
}

func TestCustomSectionTruncatedName(t *testing.T) {
	var body []byte
	body = appendU32LEB(body, 5)
	body = append(body, 'a')
	bin := encodeModule(encodeRawSection(sectionCustom, body))
	if _, err := Inspect(bin, nil); err == nil {
		t.Fatal("expected truncated custom section name error")
	}
}

func TestImportedFuncReachableInElements(t *testing.T) {
	// Imports occupy function indices 0..N-1; element refs may target them,
	// while defined-function exports may not.
	types := []FuncType{{Params: nil, Results: nil}}
	bin := encodeModule(
		encodeTypeSection(types),
		encodeImportSection([]testImport{
			{module: "env", field: "f", kind: kindFunction, typeIndex: 0},
		}),
		encodeTableSection([]testTable{{elemType: funcrefType, min: 2}}),
		encodeElementSection([]testElement{
			{flags: 0x00, offset: 0, funcs: []uint32{0}},
		}),
	)
	caps, err := Inspect(bin, []AllowedImport{{Module: "env", Field: "f", FuncType: types[0]}})
	if err != nil {
		t.Fatalf("imported func element ref rejected: %v", err)
	}
	if caps.ImportedFunctionCount() != 1 || caps.FunctionCount() != 1 {
		t.Fatalf("counts = %d/%d", caps.ImportedFunctionCount(), caps.FunctionCount())
	}
}

func TestSignedOffsetBoundaries(t *testing.T) {
	types := []FuncType{{Params: nil, Results: nil}}
	for _, offset := range []int32{-1, 0, 1, 2147483647, -2147483648} {
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{0}),
			encodeTableSection([]testTable{{elemType: funcrefType, min: 1}}),
			encodeElementSection([]testElement{
				{flags: 0x00, offset: offset, funcs: []uint32{0}},
			}),
			encodeCodeSection(1),
		)
		caps, err := Inspect(bin, nil)
		if err != nil {
			t.Fatalf("offset %d rejected: %v", offset, err)
		}
		if got := caps.Element(0).Offset; got != offset {
			t.Fatalf("offset decoded as %d, want %d", got, offset)
		}
	}
}

func TestSignedLEBNonCanonicalRejected(t *testing.T) {
	types := []FuncType{{Params: nil, Results: nil}}
	var body []byte
	body = appendU32LEB(body, 1)
	body = append(body, 0x00)
	body = append(body, valTypeI32)
	// The fifth byte 0x10 has a clear sign bit with a high payload bit set,
	// which is not a valid canonical sign extension for a signed 32-bit LEB.
	body = append(body, 0xff, 0xff, 0xff, 0xff, 0x10)
	body = append(body, 0x0b)
	body = appendU32LEB(body, 0)
	bin := encodeModule(
		encodeTypeSection(types),
		encodeFunctionSection([]uint32{0}),
		encodeTableSection([]testTable{{elemType: funcrefType, min: 1}}),
		encodeRawSection(sectionElement, body),
		encodeCodeSection(1),
	)
	if _, err := Inspect(bin, nil); err == nil {
		t.Fatal("expected non-canonical signed LEB rejection")
	}
}

func TestUnsignedLEBFifthByte(t *testing.T) {
	t.Run("max uint32 five-byte encoding accepted", func(t *testing.T) {
		// Validate the decoder directly rather than allocating a 4 GiB module.
		r := &reader{buf: []byte{0xff, 0xff, 0xff, 0xff, 0x0f}}
		got, err := r.u32()
		if err != nil || got != 0xffffffff {
			t.Fatalf("u32 max = %d, err %v", got, err)
		}
	})

	t.Run("fifth byte high bits overflow", func(t *testing.T) {
		r := &reader{buf: []byte{0xff, 0xff, 0xff, 0xff, 0x10}}
		if _, err := r.u32(); err == nil {
			t.Fatal("expected unsigned LEB overflow")
		}
	})

	t.Run("fifth byte continuation rejected", func(t *testing.T) {
		r := &reader{buf: []byte{0xff, 0xff, 0xff, 0xff, 0x8f}}
		if _, err := r.u32(); err == nil {
			t.Fatal("expected fifth-byte continuation error")
		}
	})

	t.Run("truncated fifth byte rejected", func(t *testing.T) {
		r := &reader{buf: []byte{0xff, 0xff, 0xff, 0xff}}
		if _, err := r.u32(); err == nil {
			t.Fatal("expected truncated unsigned LEB error")
		}
	})
}

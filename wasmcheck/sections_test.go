package wasmcheck

import (
	"strings"
	"testing"
)

func TestTableRestrictions(t *testing.T) {
	t.Run("externref table rejected", func(t *testing.T) {
		bin := encodeModule(
			encodeTableSection([]testTable{{elemType: externrefType, min: 1}}),
		)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "only funcref") {
			t.Fatalf("expected funcref-only error, got %v", err)
		}
	})

	t.Run("shared limits flag rejected", func(t *testing.T) {
		var body []byte
		body = appendU32LEB(body, 1)
		body = append(body, funcrefType, 0x03)
		body = appendU32LEB(body, 1)
		body = appendU32LEB(body, 2)
		bin := encodeModule(encodeRawSection(sectionTable, body))
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "unsupported limits flag") {
			t.Fatalf("expected limits flag error, got %v", err)
		}
	})

	t.Run("max smaller than min rejected", func(t *testing.T) {
		bin := encodeModule(
			encodeTableSection([]testTable{
				{elemType: funcrefType, min: 9, max: 2, hasMax: true},
			}),
		)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "max 2 is smaller than min 9") {
			t.Fatalf("expected bounds error, got %v", err)
		}
	})
}

func TestElementRestrictions(t *testing.T) {
	base, allowed := validModule()

	t.Run("passive segment rejected", func(t *testing.T) {
		bin := replaceElement(base, []testElement{{flags: 0x01, funcs: []uint32{2}}})
		if _, err := Inspect(bin, allowed); err == nil ||
			!strings.Contains(err.Error(), "only active funcref segments") {
			t.Fatalf("expected active-only error, got %v", err)
		}
	})

	t.Run("declarative segment rejected", func(t *testing.T) {
		bin := replaceElement(base, []testElement{{flags: 0x03, funcs: []uint32{2}}})
		if _, err := Inspect(bin, allowed); err == nil {
			t.Fatal("expected declarative segment to be rejected")
		}
	})

	t.Run("unreachable function reference rejected", func(t *testing.T) {
		bin := replaceElement(base, []testElement{
			{flags: 0x00, offset: 0, funcs: []uint32{4}},
		})
		if _, err := Inspect(bin, allowed); err == nil ||
			!strings.Contains(err.Error(), "function index 4 is not reachable") {
			t.Fatalf("expected reachability error, got %v", err)
		}
	})

	t.Run("explicit table index out of range rejected", func(t *testing.T) {
		bin := replaceElement(base, []testElement{
			{flags: 0x02, tableIndex: 5, offset: 1, funcs: []uint32{2}},
		})
		if _, err := Inspect(bin, allowed); err == nil ||
			!strings.Contains(err.Error(), "table index 5 out of range") {
			t.Fatalf("expected table range error, got %v", err)
		}
	})

	t.Run("explicit funcref table accepted", func(t *testing.T) {
		bin := replaceElement(base, []testElement{
			{flags: 0x02, tableIndex: 0, offset: -3, funcs: []uint32{0, 3}},
		})
		caps, err := Inspect(bin, allowed)
		if err != nil {
			t.Fatalf("explicit table segment rejected: %v", err)
		}
		seg := caps.Element(0)
		if seg.TableIndex != 0 || seg.Offset != -3 ||
			len(seg.FuncIndices) != 2 || seg.FuncIndices[0] != 0 || seg.FuncIndices[1] != 3 {
			t.Fatalf("segment = %+v", seg)
		}
	})

	t.Run("element without any table rejected", func(t *testing.T) {
		types := []FuncType{{Params: nil, Results: nil}}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{0}),
			encodeElementSection([]testElement{{flags: 0x00, offset: 0, funcs: []uint32{0}}}),
			encodeCodeSection(1),
		)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "no table is defined") {
			t.Fatalf("expected missing-table error, got %v", err)
		}
	})
}

// replaceElement rebuilds the baseline module with altered element segments.
func replaceElement(_ []byte, segments []testElement) []byte {
	types := []FuncType{
		{Params: []byte{valTypeI32}, Results: []byte{valTypeI32}},
		{Params: nil, Results: []byte{valTypeI64}},
		{Params: []byte{valTypeI64, valTypeF32}, Results: nil},
	}
	return encodeModule(
		encodeTypeSection(types),
		encodeImportSection([]testImport{
			{module: "env", field: "increment", kind: kindFunction, typeIndex: 0},
			{module: "env", field: "now", kind: kindFunction, typeIndex: 1},
		}),
		encodeFunctionSection([]uint32{2, 0}),
		encodeTableSection([]testTable{{elemType: funcrefType, min: 4, max: 8, hasMax: true}}),
		encodeExportSection([]testExport{
			{name: "worker", kind: kindFunction, index: 2},
		}),
		encodeElementSection(segments),
		encodeCodeSection(2),
	)
}

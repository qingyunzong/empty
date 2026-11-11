package wasmcheck

import (
	"strings"
	"testing"
)

func TestInspectValidModule(t *testing.T) {
	bin, allowed := validModule()
	caps, err := Inspect(bin, allowed)
	if err != nil {
		t.Fatalf("Inspect returned error: %v", err)
	}

	if got := caps.TypeCount(); got != 3 {
		t.Fatalf("TypeCount = %d, want 3", got)
	}
	fn := caps.Type(0)
	if len(fn.Params) != 1 || fn.Params[0] != valTypeI32 ||
		len(fn.Results) != 1 || fn.Results[0] != valTypeI32 {
		t.Fatalf("Type(0) = %+v, want (i32) -> i32", fn)
	}

	if got := caps.ImportedFunctionCount(); got != 2 {
		t.Fatalf("ImportedFunctionCount = %d, want 2", got)
	}
	if got := caps.FunctionCount(); got != 4 {
		t.Fatalf("FunctionCount = %d, want 4", got)
	}
	if got := caps.DefinedFunctionCount(); got != 2 {
		t.Fatalf("DefinedFunctionCount = %d, want 2", got)
	}
	imp0 := caps.Import(0)
	if imp0.Module != "env" || imp0.Field != "increment" ||
		imp0.FuncIndex != 0 || imp0.TypeIndex != 0 {
		t.Fatalf("Import(0) = %+v", imp0)
	}
	imp1 := caps.Import(1)
	if imp1.FuncIndex != 1 || imp1.TypeIndex != 1 {
		t.Fatalf("Import(1) = %+v", imp1)
	}
	if got := caps.DefinedFunctionType(0); got != 2 {
		t.Fatalf("DefinedFunctionType(0) = %d, want 2", got)
	}

	if got := caps.TableCount(); got != 1 {
		t.Fatalf("TableCount = %d, want 1", got)
	}
	tab := caps.Table(0)
	if tab.Min != 4 || tab.Max != 8 || !tab.HasMax {
		t.Fatalf("Table(0) = %+v, want min 4 max 8 with max", tab)
	}

	if got := caps.ExportCount(); got != 3 {
		t.Fatalf("ExportCount = %d, want 3", got)
	}
	worker, ok := caps.ExportByName("worker")
	if !ok || worker.Index != 2 || worker.Kind != kindFunction {
		t.Fatalf("worker export = %+v ok=%v", worker, ok)
	}
	tableExport, ok := caps.ExportByName("table0")
	if !ok || tableExport.Kind != kindTable || tableExport.Index != 0 {
		t.Fatalf("table0 export = %+v ok=%v", tableExport, ok)
	}

	if got := caps.ElementCount(); got != 1 {
		t.Fatalf("ElementCount = %d, want 1", got)
	}
	seg := caps.Element(0)
	if seg.TableIndex != 0 || seg.Offset != 0 || len(seg.FuncIndices) != 3 {
		t.Fatalf("Element(0) = %+v", seg)
	}
	wantRefs := []uint32{2, 3, 0}
	for i, ref := range wantRefs {
		if seg.FuncIndices[i] != ref {
			t.Fatalf("element ref %d = %d, want %d", i, seg.FuncIndices[i], ref)
		}
	}
}

func TestImportAllowlist(t *testing.T) {
	base, allowed := validModule()

	t.Run("forged signature rejected", func(t *testing.T) {
		forged := append([]AllowedImport(nil), allowed...)
		forged[0] = AllowedImport{
			Module:   "env",
			Field:    "increment",
			FuncType: FuncType{Params: []byte{valTypeI64}, Results: []byte{valTypeI32}},
		}
		if _, err := Inspect(base, forged); err == nil ||
			!strings.Contains(err.Error(), "signature does not match") {
			t.Fatalf("expected signature mismatch error, got %v", err)
		}
	})

	t.Run("missing allowlist entry rejected", func(t *testing.T) {
		if _, err := Inspect(base, allowed[:1]); err == nil ||
			!strings.Contains(err.Error(), "not in the host allowlist") {
			t.Fatalf("expected allowlist error, got %v", err)
		}
	})

	t.Run("non-function import rejected", func(t *testing.T) {
		types := []FuncType{{Params: nil, Results: nil}}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeImportSection([]testImport{
				{module: "env", field: "table", kind: kindTable, typeIndex: 0},
			}),
		)
		_, err := Inspect(bin, []AllowedImport{{
			Module: "env", Field: "table", FuncType: types[0],
		}})
		if err == nil || !strings.Contains(err.Error(), "only function imports") {
			t.Fatalf("expected function-only import error, got %v", err)
		}
	})

	t.Run("extra allowed entries are harmless", func(t *testing.T) {
		extra := append([]AllowedImport(nil), allowed...)
		extra = append(extra, AllowedImport{
			Module:   "env",
			Field:    "unused",
			FuncType: FuncType{Params: nil, Results: nil},
		})
		if _, err := Inspect(base, extra); err != nil {
			t.Fatalf("Inspect with superset allowlist: %v", err)
		}
	})

	t.Run("empty allowlist entry rejected up front", func(t *testing.T) {
		bad := []AllowedImport{{Module: "", Field: "x"}}
		if _, err := Inspect(base, bad); err == nil {
			t.Fatal("expected error for empty allowed module name")
		}
	})
}

func TestTypeIndexValidation(t *testing.T) {
	types := []FuncType{{Params: nil, Results: nil}}

	t.Run("import type index out of range", func(t *testing.T) {
		bin := encodeModule(
			encodeTypeSection(types),
			encodeImportSection([]testImport{
				{module: "env", field: "f", kind: kindFunction, typeIndex: 7},
			}),
		)
		_, err := Inspect(bin, []AllowedImport{{
			Module: "env", Field: "f", FuncType: types[0],
		}})
		if err == nil || !strings.Contains(err.Error(), "type index 7 out of range") {
			t.Fatalf("expected out-of-range type index, got %v", err)
		}
	})

	t.Run("defined function type index out of range", func(t *testing.T) {
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{1}),
		)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "type index 1 out of range") {
			t.Fatalf("expected out-of-range type index, got %v", err)
		}
	})
}

func TestExportIndexMustSkipImports(t *testing.T) {
	base, allowed := validModule()

	t.Run("export pointing at imported function rejected", func(t *testing.T) {
		bin := replaceExport(base, testExport{name: "bad", kind: kindFunction, index: 1})
		_, err := Inspect(bin, allowed)
		if err == nil || !strings.Contains(err.Error(), "imported function index") {
			t.Fatalf("expected imported-function export error, got %v", err)
		}
	})

	t.Run("export beyond function count rejected", func(t *testing.T) {
		bin := replaceExport(base, testExport{name: "bad", kind: kindFunction, index: 99})
		_, err := Inspect(bin, allowed)
		if err == nil || !strings.Contains(err.Error(), "out of range") {
			t.Fatalf("expected out-of-range export error, got %v", err)
		}
	})

	t.Run("memory and global exports rejected", func(t *testing.T) {
		for _, kind := range []byte{kindMemory, kindGlobal} {
			bin := replaceExport(base, testExport{name: "bad", kind: kind, index: 0})
			_, err := Inspect(bin, allowed)
			if err == nil || !strings.Contains(err.Error(), "only function and table exports") {
				t.Fatalf("kind 0x%02x: expected restricted export error, got %v", kind, err)
			}
		}
	})

	t.Run("duplicate export name rejected", func(t *testing.T) {
		types := []FuncType{{Params: nil, Results: nil}}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{0, 0}),
			encodeExportSection([]testExport{
				{name: "dup", kind: kindFunction, index: 0},
				{name: "dup", kind: kindFunction, index: 1},
			}),
		)
		_, err := Inspect(bin, nil)
		if err == nil || !strings.Contains(err.Error(), "duplicate export") {
			t.Fatalf("expected duplicate export error, got %v", err)
		}
	})
}

// replaceExport rebuilds the baseline module with a single altered export.
func replaceExport(_ []byte, export testExport) []byte {
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
		encodeExportSection([]testExport{export}),
		encodeElementSection([]testElement{{flags: 0x00, offset: 0, funcs: []uint32{2, 3, 0}}}),
		encodeCodeSection(2),
	)
}

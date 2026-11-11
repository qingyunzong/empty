package wasmcheck

import (
	"errors"
	"strings"
	"testing"
)

func TestSectionOrderingAndCustomSections(t *testing.T) {
	base, allowed := validModule()

	t.Run("duplicated standard section rejected", func(t *testing.T) {
		bin := append(append([]byte(nil), base...), encodeTypeSection(nil)...)
		if _, err := Inspect(bin, allowed); err == nil ||
			!strings.Contains(err.Error(), "duplicated or out of order") {
			t.Fatalf("expected ordering error, got %v", err)
		}
	})

	t.Run("out-of-order sections rejected", func(t *testing.T) {
		// Export (7) placed before Table (4).
		types := []FuncType{{Params: nil, Results: nil}}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{0}),
			encodeExportSection([]testExport{{name: "f", kind: kindFunction, index: 0}}),
			encodeTableSection([]testTable{{elemType: funcrefType, min: 1}}),
			encodeCodeSection(1),
		)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "duplicated or out of order") {
			t.Fatalf("expected ordering error, got %v", err)
		}
	})

	t.Run("repeated custom sections accepted anywhere", func(t *testing.T) {
		types := []FuncType{{Params: nil, Results: nil}}
		bin := encodeModule(
			encodeCustomSection("meta", []byte("first")),
			encodeTypeSection(types),
			encodeCustomSection("meta", []byte("second")),
			encodeFunctionSection([]uint32{0}),
			encodeCustomSection("trailing", []byte{1, 2, 3}),
			encodeCodeSection(1),
		)
		caps, err := Inspect(bin, nil)
		if err != nil {
			t.Fatalf("repeated custom sections rejected: %v", err)
		}
		if caps.FunctionCount() != 1 {
			t.Fatalf("FunctionCount = %d, want 1", caps.FunctionCount())
		}
	})

	t.Run("custom section with empty name rejected", func(t *testing.T) {
		bin := encodeModule(encodeCustomSection("", []byte("x")))
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "empty name") {
			t.Fatalf("expected empty-name error, got %v", err)
		}
	})

	t.Run("unknown section id rejected", func(t *testing.T) {
		bin := encodeModule(encodeRawSection(99, nil))
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "unknown standard section id 99") {
			t.Fatalf("expected unknown section error, got %v", err)
		}
	})

	t.Run("other sections only checked for order and length", func(t *testing.T) {
		types := []FuncType{{Params: nil, Results: nil}}
		memBody := []byte{0x01, 0x00, 0x01}
		bin := encodeModule(
			encodeTypeSection(types),
			encodeFunctionSection([]uint32{0}),
			encodeRawSection(sectionMemory, memBody),
			encodeCodeSection(1),
		)
		if _, err := Inspect(bin, nil); err != nil {
			t.Fatalf("opaque section handling failed: %v", err)
		}
	})
}

func TestLEB128OverflowAndTruncation(t *testing.T) {
	header := []byte{0x00, 'a', 's', 'm', 0x01, 0x00, 0x00, 0x00}

	t.Run("u32 overflow in section length rejected", func(t *testing.T) {
		bin := append(append([]byte(nil), header...),
			sectionType, 0xff, 0xff, 0xff, 0xff, 0x10)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "overflows 32 bits") {
			t.Fatalf("expected overflow error, got %v", err)
		}
	})

	t.Run("truncated LEB rejected", func(t *testing.T) {
		bin := append(append([]byte(nil), header...), sectionType, 0x80, 0x80)
		if _, err := Inspect(bin, nil); err == nil {
			t.Fatal("expected truncated LEB error")
		}
	})

	t.Run("overlong non-canonical u32 rejected", func(t *testing.T) {
		var body []byte
		body = appendU32LEB(body, 1)
		body = append(body, funcTypeMarker)
		body = append(body, 0x80, 0x80, 0x80, 0x80, 0x10)
		bin := encodeModule(encodeRawSection(sectionType, body))
		if _, err := Inspect(bin, nil); err == nil {
			t.Fatal("expected non-canonical LEB rejection")
		}
	})

	t.Run("s32 non-canonical sign extension rejected", func(t *testing.T) {
		types := []FuncType{{Params: nil, Results: nil}}
		var body []byte
		body = appendU32LEB(body, 1)
		body = append(body, 0x00)
		body = append(body, valTypeI32)
		// A fifth byte of 0x10 has a clear sign bit but sets a high payload
		// bit, so it cannot be a canonical sign extension of a signed 32-bit
		// value and must be rejected.
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
			t.Fatal("expected signed LEB rejection")
		}
	})
}

func TestSectionLengthBoundaries(t *testing.T) {
	header := []byte{0x00, 'a', 's', 'm', 0x01, 0x00, 0x00, 0x00}

	t.Run("section length beyond module rejected", func(t *testing.T) {
		bin := append(append([]byte(nil), header...), sectionType, 0x05, 0x60)
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "exceeds remaining module bytes") {
			t.Fatalf("expected length boundary error, got %v", err)
		}
	})

	t.Run("section payload shorter than contents rejected", func(t *testing.T) {
		bin := encodeModule(encodeRawSection(sectionType, []byte{0x02}))
		if _, err := Inspect(bin, nil); err == nil {
			t.Fatal("expected truncated payload error")
		}
	})

	t.Run("trailing bytes inside section rejected", func(t *testing.T) {
		bin := encodeModule(encodeRawSection(sectionType, []byte{0x00, 0x42}))
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "trailing byte") {
			t.Fatalf("expected trailing-byte error, got %v", err)
		}
	})

	t.Run("payload cannot bleed into next section", func(t *testing.T) {
		// A declared type-section length swallowing the following section
		// must surface as a malformed type section, not cross-section reads.
		var bin []byte
		bin = append(bin, header...)
		bin = append(bin, sectionType, 0x02, 0x01, 0x00)
		bin = append(bin, encodeMemorySectionForTest()...)
		if _, err := Inspect(bin, nil); err == nil {
			t.Fatal("expected bounded-section error")
		}
	})
}

func TestHeaderAndVersion(t *testing.T) {
	t.Run("empty input rejected", func(t *testing.T) {
		if _, err := Inspect(nil, nil); err == nil {
			t.Fatal("expected empty-input error")
		}
	})

	t.Run("bad magic rejected", func(t *testing.T) {
		bin := []byte{0x01, 'a', 's', 'm', 0x01, 0x00, 0x00, 0x00}
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "magic") {
			t.Fatalf("expected magic error, got %v", err)
		}
	})

	t.Run("non-version-1 rejected", func(t *testing.T) {
		bin := []byte{0x00, 'a', 's', 'm', 0x02, 0x00, 0x00, 0x00}
		if _, err := Inspect(bin, nil); err == nil ||
			!strings.Contains(err.Error(), "unsupported binary version 2") {
			t.Fatalf("expected version error, got %v", err)
		}
	})
}

var errInstantiateSentinel = errors.New("instantiate failed")

func TestLoadCallbackContract(t *testing.T) {
	bin, allowed := validModule()

	t.Run("callback invoked with capabilities on success", func(t *testing.T) {
		called := false
		caps, err := Load(bin, allowed, func(c *Capabilities) error {
			called = true
			if c.FunctionCount() != 4 {
				t.Fatalf("callback saw FunctionCount %d, want 4", c.FunctionCount())
			}
			return nil
		})
		if err != nil {
			t.Fatalf("Load returned error: %v", err)
		}
		if !called {
			t.Fatal("instantiation callback was not called")
		}
		if caps == nil {
			t.Fatal("Load returned nil capabilities")
		}
	})

	t.Run("callback not invoked when inspection fails", func(t *testing.T) {
		called := false
		forged := append([]AllowedImport(nil), allowed...)
		forged[0] = AllowedImport{
			Module:   "env",
			Field:    "increment",
			FuncType: FuncType{Params: []byte{valTypeI64}, Results: []byte{valTypeI32}},
		}
		if _, err := Load(bin, forged, func(*Capabilities) error {
			called = true
			return nil
		}); err == nil {
			t.Fatal("expected inspection failure")
		}
		if called {
			t.Fatal("instantiation callback must not run after failed inspection")
		}
	})

	t.Run("callback error propagated", func(t *testing.T) {
		_, err := Load(bin, allowed, func(*Capabilities) error {
			return errInstantiateSentinel
		})
		if !errors.Is(err, errInstantiateSentinel) {
			t.Fatalf("expected sentinel error, got %v", err)
		}
	})
}

func TestCapabilitiesAreReadOnly(t *testing.T) {
	bin, allowed := validModule()
	caps, err := Inspect(bin, allowed)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}

	t1 := caps.Type(0)
	t1.Params[0] = valTypeF64
	if caps.Type(0).Params[0] != valTypeI32 {
		t.Fatal("mutation of returned Type leaked into capabilities")
	}

	seg := caps.Element(0)
	seg.FuncIndices[0] = 99
	if caps.Element(0).FuncIndices[0] != 2 {
		t.Fatal("mutation of returned element leaked into capabilities")
	}
}

// encodeMemorySectionForTest emits a minimal opaque memory section used to
// verify section boundaries; its contents are never parsed.
func encodeMemorySectionForTest() []byte {
	return encodeRawSection(sectionMemory, []byte{0x01, 0x00, 0x01})
}

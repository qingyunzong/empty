package dataeng

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"testing"
)

// The types below form a deliberately simple, fully expanded reference
// implementation for tests only. They do not use Context internals and are
// intentionally small enough to materialize every slot.

type refSlot struct {
	text  string
	known bool
}

type refKey struct {
	name    string
	version uint64
}

type refDirectory map[refKey][]refSlot

type refImport struct {
	name   string
	start  uint64
	length uint64
	slots  []refSlot
}

type refContext struct {
	system  []string
	imports []refImport
	local   []string
	prefix  uint64
	max     uint64
}

func refEquivalent(a, b Token) bool {
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case KnownKind:
		return a.Text == b.Text
	case LocalUnknownKind:
		return true
	case SharedUnknownKind:
		return a.Name == b.Name && a.Ordinal == b.Ordinal
	default:
		return false
	}
}

func refBuildContext(system []string, imports []Import, directory refDirectory) (refContext, error) {
	context := refContext{system: append([]string(nil), system...)}
	total := uint64(len(context.system))

	for _, spec := range imports {
		if spec.Name == "" {
			return refContext{}, errors.New("empty name")
		}
		if spec.Version == 0 {
			return refContext{}, errors.New("zero version")
		}

		exactKey := refKey{spec.Name, spec.Version}
		exactSlots, exactFound := directory[exactKey]
		var slots []refSlot
		var length uint64
		if exactFound {
			slots = exactSlots
			if spec.MaxID == nil {
				length = uint64(len(slots))
			} else {
				length = *spec.MaxID
			}
		} else {
			if spec.MaxID == nil {
				return refContext{}, errors.New("exact version absent")
			}
			length = *spec.MaxID
			var bestVersion uint64
			var bestSlots []refSlot
			var found bool
			for key, candidate := range directory {
				if key.name != spec.Name {
					continue
				}
				if !found || key.version > bestVersion {
					bestVersion = key.version
					bestSlots = candidate
					found = true
				}
			}
			if found {
				slots = bestSlots
			}
		}

		if length > math.MaxUint64-total {
			return refContext{}, errors.New("SID overflow")
		}
		area := refImport{name: spec.Name, length: length, slots: slots}
		if length != 0 {
			area.start = total + 1
			total += length
		}
		context.imports = append(context.imports, area)
	}

	context.prefix = total
	context.max = total
	return context, nil
}

func refResolve(context refContext, sid uint64) (Token, error) {
	if sid == 0 {
		return LocalUnknown(), nil
	}
	if sid > context.max {
		return Token{}, errors.New("out of range")
	}
	if sid <= uint64(len(context.system)) {
		return Known(context.system[sid-1]), nil
	}
	for _, area := range context.imports {
		if area.length == 0 || sid < area.start {
			continue
		}
		offset := sid - area.start
		if offset < area.length {
			ordinal := offset + 1
			if ordinal <= uint64(len(area.slots)) && area.slots[ordinal-1].known {
				return Known(area.slots[ordinal-1].text), nil
			}
			return SharedUnknown(area.name, ordinal), nil
		}
	}
	if sid > context.prefix {
		index := sid - context.prefix - 1
		if index < uint64(len(context.local)) {
			return Known(context.local[index]), nil
		}
	}
	return Token{}, errors.New("unreachable SID")
}

func refLookup(context refContext, token Token) (uint64, bool) {
	switch token.Kind {
	case LocalUnknownKind:
		return 0, true
	case KnownKind:
		for index, text := range context.system {
			if text == token.Text {
				return uint64(index) + 1, true
			}
		}
		for _, area := range context.imports {
			visible := uint64(len(area.slots))
			if area.length < visible {
				visible = area.length
			}
			for index := uint64(0); index < visible; index++ {
				if area.slots[index].known && area.slots[index].text == token.Text {
					return area.start + index, true
				}
			}
		}
		for index, text := range context.local {
			if text == token.Text {
				return context.prefix + uint64(index) + 1, true
			}
		}
		return 0, false
	case SharedUnknownKind:
		if token.Name == "" || token.Ordinal == 0 {
			return 0, false
		}
		for _, area := range context.imports {
			if area.name != token.Name || area.length == 0 || token.Ordinal > area.length {
				continue
			}
			if token.Ordinal > uint64(len(area.slots)) || !area.slots[token.Ordinal-1].known {
				return area.start + token.Ordinal - 1, true
			}
		}
		return 0, false
	default:
		return 0, false
	}
}

func refAppendLocal(context refContext, texts []string) (refContext, error) {
	if uint64(len(texts)) > math.MaxUint64-context.max {
		return refContext{}, errors.New("overflow")
	}
	result := context
	result.local = append([]string(nil), context.local...)
	result.local = append(result.local, texts...)
	result.max += uint64(len(texts))
	return result, nil
}

func refRelocate(tokens []Token, target refContext) (refContext, []uint64, int, bool) {
	sids := make([]uint64, len(tokens))
	var appended []string
	appendedSIDs := make(map[string]uint64)

	for index, token := range tokens {
		switch token.Kind {
		case LocalUnknownKind:
			sids[index] = 0
		case KnownKind:
			if sid, found := refLookup(target, token); found {
				sids[index] = sid
				continue
			}
			if sid, found := appendedSIDs[token.Text]; found {
				sids[index] = sid
				continue
			}
			if uint64(len(appended)) >= math.MaxUint64-target.max {
				return refContext{}, nil, index, false
			}
			appended = append(appended, token.Text)
			sid := target.max + uint64(len(appended))
			appendedSIDs[token.Text] = sid
			sids[index] = sid
		case SharedUnknownKind:
			sid, found := refLookup(target, token)
			if !found {
				return refContext{}, nil, index, false
			}
			sids[index] = sid
		default:
			return refContext{}, nil, index, false
		}
	}

	result := target
	if len(appended) != 0 {
		var err error
		result, err = refAppendLocal(target, appended)
		if err != nil {
			return refContext{}, nil, 0, false
		}
	}
	for index, token := range tokens {
		resolved, err := refResolve(result, sids[index])
		if err != nil || !refEquivalent(token, resolved) {
			return refContext{}, nil, index, false
		}
	}
	return result, sids, -1, true
}

func toDirectory(directory refDirectory) Directory {
	result := make(Directory, len(directory))
	for key, slots := range directory {
		slotCopy := make([]Slot, len(slots))
		for index, slot := range slots {
			slotCopy[index] = Slot{Text: slot.text, Known: slot.known}
		}
		result[Key{key.name, key.version}] = Table{Slots: slotCopy}
	}
	return result
}

func compareContext(t *testing.T, label string, reference refContext, actual *Context) {
	t.Helper()
	if actual == nil {
		t.Fatalf("%s: actual Context is nil", label)
	}
	if actual.MaxSID() != reference.max {
		t.Fatalf("%s: MaxSID = %d, want %d", label, actual.MaxSID(), reference.max)
	}
	if actual.LocalLen() != len(reference.local) {
		t.Fatalf("%s: LocalLen = %d, want %d", label, actual.LocalLen(), len(reference.local))
	}
	for sid := uint64(0); sid <= reference.max+2; sid++ {
		want, wantErr := refResolve(reference, sid)
		got, gotErr := actual.Resolve(sid)
		if (wantErr != nil) != (gotErr != nil) {
			t.Fatalf("%s: Resolve(%d) error = %v, want error %v", label, sid, gotErr, wantErr)
		}
		if wantErr == nil && !Equivalent(want, got) {
			t.Fatalf("%s: Resolve(%d) = %s, want %s", label, sid, got, want)
		}
	}
}

func randomDirectory(rng *rand.Rand, texts []string, names []string) refDirectory {
	directory := make(refDirectory)
	for _, name := range names {
		if rng.Intn(4) == 0 {
			continue // entire table name missing
		}
		versions := rng.Intn(4)
		for version := 1; version <= versions; version++ {
			length := rng.Intn(6)
			slots := make([]refSlot, length)
			for index := range slots {
				slots[index] = refSlot{
					text:  texts[rng.Intn(len(texts))],
					known: rng.Intn(4) != 0,
				}
				if !slots[index].known {
					slots[index].text = ""
				}
			}
			// Ensure both known and unknown tables occur.
			if length > 0 && version == 1 && rng.Intn(3) == 0 {
				for index := range slots {
					slots[index] = refSlot{known: false}
				}
			}
			directory[refKey{name, uint64(version)}] = slots
		}
	}
	return directory
}

func randomImports(rng *rand.Rand, names []string, absentName string) []Import {
	count := rng.Intn(5)
	imports := make([]Import, count)
	for index := range imports {
		name := names[rng.Intn(len(names))]
		if rng.Intn(5) == 0 {
			name = absentName
		}
		version := uint64(1 + rng.Intn(4))
		imports[index] = Import{Name: name, Version: version}
		if rng.Intn(5) < 3 {
			imports[index].MaxID = MaxIDValue(uint64(rng.Intn(8)))
		}
	}
	return imports
}

func randomTokens(rng *rand.Rand, context refContext, texts, names []string) []Token {
	length := rng.Intn(11)
	tokens := make([]Token, length)
	for index := range tokens {
		switch rng.Intn(10) {
		case 0, 1, 2, 3:
			if context.max != 0 {
				sid := uint64(1) + rng.Uint64()%context.max
				token, err := refResolve(context, sid)
				if err == nil {
					tokens[index] = token
					continue
				}
			}
			tokens[index] = Known(texts[rng.Intn(len(texts))])
		case 4, 5, 6:
			tokens[index] = Known(texts[rng.Intn(len(texts))])
		case 7:
			tokens[index] = LocalUnknown()
		case 8, 9:
			tokens[index] = SharedUnknown(names[rng.Intn(len(names))],
				uint64(1+rng.Intn(10)))
		}
	}
	return tokens
}

func TestRandomizedAgainstExpandedReference(t *testing.T) {
	texts := []string{"", "a", "b", "dup", "é", "e\u0301", "注释", "x y"}
	names := []string{"t0", "t1", "t2"}
	// A name that never appears in the random directory exercises the
	// "missing table, all unknown" rule.
	const absentName = "absent-name"
	const iterations = 400

	for seed := int64(0); seed < iterations; seed++ {
		seed := seed
		t.Run(fmt.Sprintf("seed-%03d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			directory := randomDirectory(rng, texts, names)
			system := make([]string, rng.Intn(6))
			for index := range system {
				system[index] = texts[rng.Intn(len(texts))]
			}
			imports := randomImports(rng, names, absentName)

			reference, refErr := refBuildContext(system, imports, directory)
			actual, actualErr := NewContext(system, imports, toDirectory(directory))
			if (refErr != nil) != (actualErr != nil) {
				t.Fatalf("build error mismatch: reference=%v actual=%v", refErr, actualErr)
			}
			if refErr != nil {
				return
			}
			compareContext(t, "initial", reference, actual)

			lookupTokens := []Token{LocalUnknown()}
			for _, text := range texts {
				lookupTokens = append(lookupTokens, Known(text))
			}
			for _, name := range append(append([]string(nil), names...), absentName) {
				for ordinal := uint64(1); ordinal <= 10; ordinal++ {
					lookupTokens = append(lookupTokens, SharedUnknown(name, ordinal))
				}
			}
			for _, token := range lookupTokens {
				wantSID, wantFound := refLookup(reference, token)
				gotSID, gotFound := actual.Lookup(token)
				if wantFound != gotFound || (wantFound && wantSID != gotSID) {
					t.Fatalf("Lookup(%s) = (%d,%v), want (%d,%v)",
						token, gotSID, gotFound, wantSID, wantFound)
				}
			}

			appendTexts := make([]string, rng.Intn(5))
			for index := range appendTexts {
				appendTexts[index] = texts[rng.Intn(len(texts))]
			}
			referenceAfter, appendErr := refAppendLocal(reference, appendTexts)
			actualAfter, actualAppendErr := actual.AppendLocal(appendTexts...)
			if appendErr != nil || actualAppendErr != nil {
				t.Fatalf("append errors: reference=%v actual=%v", appendErr, actualAppendErr)
			}
			compareContext(t, "after append", referenceAfter, actualAfter)

			otherDirectory := randomDirectory(rng, texts, names)
			otherSystem := make([]string, rng.Intn(6))
			for index := range otherSystem {
				otherSystem[index] = texts[rng.Intn(len(texts))]
			}
			otherImports := randomImports(rng, names, absentName)
			otherRef, otherRefErr := refBuildContext(otherSystem, otherImports, otherDirectory)
			otherActual, otherActualErr := NewContext(otherSystem, otherImports, toDirectory(otherDirectory))
			if (otherRefErr != nil) != (otherActualErr != nil) {
				t.Fatalf("other build error mismatch: reference=%v actual=%v", otherRefErr, otherActualErr)
			}
			if otherRefErr != nil {
				return
			}

			tokens := randomTokens(rng, reference, texts, names)
			before := otherRef
			wantResult, wantSIDs, wantFail, wantOK := refRelocate(tokens, otherRef)
			gotResult, gotSIDs, gotFail, gotErr := RelocateWithIndex(tokens, otherActual)
			if wantOK != (gotErr == nil) {
				t.Fatalf("relocation outcome mismatch: reference ok=%v actual err=%v tokens=%v",
					wantOK, gotErr, tokens)
			}
			if !wantOK {
				if gotFail != wantFail {
					t.Fatalf("failure index = %d, want %d", gotFail, wantFail)
				}
				if gotResult != nil || gotSIDs != nil {
					t.Fatalf("failed relocation delivered partial output")
				}
				compareContext(t, "unchanged target", before, otherActual)
				return
			}
			if gotFail != -1 {
				t.Fatalf("success fail index = %d", gotFail)
			}
			if len(gotSIDs) != len(wantSIDs) {
				t.Fatalf("len(sids) = %d, want %d", len(gotSIDs), len(wantSIDs))
			}
			for index := range wantSIDs {
				if gotSIDs[index] != wantSIDs[index] {
					t.Fatalf("sids[%d] = %d, want %d (all: %v vs %v)",
						index, gotSIDs[index], wantSIDs[index], gotSIDs, wantSIDs)
				}
			}
			compareContext(t, "relocated target", wantResult, gotResult)
			for index, token := range tokens {
				resolved, err := gotResult.Resolve(gotSIDs[index])
				if err != nil || !Equivalent(token, resolved) {
					t.Fatalf("relocated SID %d resolves to %s, want %s", gotSIDs[index], resolved, token)
				}
			}
		})
	}
}

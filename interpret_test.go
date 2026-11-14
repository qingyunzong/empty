package dataeng

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func testMetadata() Metadata {
	return Metadata{
		Version: "2026-11",
		Regions: map[string]Region{
			"CA": {
				CountryCode:           "1",
				InternationalPrefix:   "011",
				NationalPrefix:        "1",
				NationalNumberLengths: []int{10},
			},
			"DE": {
				CountryCode:           "49",
				InternationalPrefix:   "00",
				NationalPrefix:        "0",
				NationalNumberLengths: []int{10, 11},
			},
			"GB": {
				CountryCode:           "44",
				InternationalPrefix:   "00",
				NationalPrefix:        "0",
				NationalNumberLengths: []int{10},
				ValidNumberPatterns:   []string{`20[0-9]{8}`},
			},
			"US": {
				CountryCode:           "1",
				InternationalPrefix:   "011",
				NationalPrefix:        "1",
				NationalNumberLengths: []int{10},
			},
		},
	}
}

func mustInterpreter(t *testing.T, metadata Metadata, region string) *Interpreter {
	t.Helper()
	interpreter, err := NewInterpreter(metadata, region)
	if err != nil {
		t.Fatalf("NewInterpreter: %v", err)
	}
	return interpreter
}

func findCandidate(t *testing.T, result Result, predicate func(Interpretation) bool) Interpretation {
	t.Helper()
	for _, candidate := range result.Interpretations {
		if predicate(candidate) {
			return candidate
		}
	}
	t.Fatalf("candidate not found in %#v", result.Interpretations)
	return Interpretation{}
}

func hasEvidence(candidate Interpretation, kind EvidenceKind) bool {
	for _, evidence := range candidate.Evidence {
		if evidence.Kind == kind {
			return true
		}
	}
	return false
}

func TestInternationalPlusWithParenthesizedTrunkAndExtension(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")
	result, err := interpreter.Interpret("+44 (0)20 7946 0018 ext. 42")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Interpretations) != 1 {
		t.Fatalf("got %d interpretations, want 1: %#v", len(result.Interpretations), result.Interpretations)
	}

	candidate := result.Interpretations[0]
	if candidate.Kind != KindInternationalPlus {
		t.Errorf("kind = %q", candidate.Kind)
	}
	if candidate.InternationalPrefix != "+" {
		t.Errorf("international prefix = %q", candidate.InternationalPrefix)
	}
	if candidate.CountryCode != "44" || candidate.CountryCodeInferred {
		t.Errorf("country code = %q inferred=%v", candidate.CountryCode, candidate.CountryCodeInferred)
	}
	if candidate.TrunkPrefix != "0" || !candidate.TrunkParenthesized {
		t.Errorf("trunk = %q parenthesized=%v", candidate.TrunkPrefix, candidate.TrunkParenthesized)
	}
	if candidate.NationalNumber != "2079460018" {
		t.Errorf("national number = %q", candidate.NationalNumber)
	}
	if candidate.Extension != "42" {
		t.Errorf("extension = %q", candidate.Extension)
	}
	if candidate.E164 != "+442079460018" {
		t.Errorf("E164 = %q", candidate.E164)
	}
	if candidate.RFC3966 != "tel:+442079460018;ext=42" {
		t.Errorf("RFC3966 = %q", candidate.RFC3966)
	}
	if candidate.Possibility != PossibilityPossible || !candidate.Possible {
		t.Errorf("possibility = %q possible=%v", candidate.Possibility, candidate.Possible)
	}
	if candidate.Validity != ValidityValid || !candidate.Valid {
		t.Errorf("validity = %q valid=%v", candidate.Validity, candidate.Valid)
	}
	if !candidate.WellFormed {
		t.Error("candidate should be well formed")
	}
	for _, kind := range []EvidenceKind{
		EvidenceInternationalPrefix,
		EvidenceCountryCode,
		EvidenceTrunkPrefix,
		EvidenceNationalNumber,
		EvidenceExtensionMarker,
		EvidenceExtension,
		EvidencePossibility,
		EvidenceValidity,
	} {
		if !hasEvidence(candidate, kind) {
			t.Errorf("missing evidence %q", kind)
		}
	}
}

func TestIDDAndBareCountryCodeAreDistinguishedFromTrunk(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "US")

	iddResult, err := interpreter.Interpret("011 44 20 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	idd := findCandidate(t, iddResult, func(candidate Interpretation) bool {
		return candidate.Kind == KindInternationalIDD
	})
	if idd.InternationalPrefix != "011" || idd.CountryCode != "44" || idd.NationalNumber != "2079460018" {
		t.Errorf("IDD candidate = %#v", idd)
	}
	if !hasEvidence(idd, EvidenceInternationalPrefix) {
		t.Error("IDD candidate lacks international-prefix evidence")
	}

	ambiguousResult, err := interpreter.Interpret("1 (202) 555-0100")
	if err != nil {
		t.Fatal(err)
	}
	trunk := findCandidate(t, ambiguousResult, func(candidate Interpretation) bool {
		return candidate.Kind == KindNationalTrunk
	})
	if trunk.TrunkPrefix != "1" || trunk.NationalNumber != "2025550100" {
		t.Errorf("trunk candidate = %#v", trunk)
	}

	bare := findCandidate(t, ambiguousResult, func(candidate Interpretation) bool {
		return candidate.Kind == KindInternationalBare
	})
	if bare.CountryCode != "1" || bare.NationalNumber != "2025550100" || bare.InternationalPrefix != "" {
		t.Errorf("bare country-code candidate = %#v", bare)
	}
	if !bare.RegionAmbiguous || !containsString(bare.RegionCandidates, "CA") || !containsString(bare.RegionCandidates, "US") {
		t.Errorf("shared country code regions = %#v", bare.RegionCandidates)
	}
	if bare.Region != "US" {
		t.Errorf("primary region = %q, want default region US", bare.Region)
	}
}

func TestFormattingSuccessIsNotValidity(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "US")
	result, err := interpreter.Interpret("+1 202 555 010")
	if err != nil {
		t.Fatal(err)
	}
	candidate := findCandidate(t, result, func(candidate Interpretation) bool {
		return candidate.Kind == KindInternationalPlus
	})
	if !candidate.WellFormed {
		t.Error("parse succeeded, candidate should be well formed")
	}
	if candidate.Possibility != PossibilityImpossible || candidate.Possible {
		t.Errorf("possibility = %q possible=%v", candidate.Possibility, candidate.Possible)
	}
	if candidate.Validity != ValidityUnknown || candidate.Valid {
		t.Errorf("validity = %q valid=%v", candidate.Validity, candidate.Valid)
	}
	if !hasEvidence(candidate, EvidencePossibility) {
		t.Error("impossible candidate should explain the length check")
	}
}

func TestExplicitValidityPatternsDoNotAffectPossibility(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")

	valid, err := interpreter.Interpret("+44 20 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	validCandidate := valid.Interpretations[0]
	if validCandidate.Validity != ValidityValid || !validCandidate.Valid {
		t.Fatalf("expected explicit validity, got %q", validCandidate.Validity)
	}

	invalid, err := interpreter.Interpret("+44 21 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	invalidCandidate := invalid.Interpretations[0]
	if invalidCandidate.Possibility != PossibilityPossible || !invalidCandidate.Possible {
		t.Fatalf("expected possible length, got %q", invalidCandidate.Possibility)
	}
	if invalidCandidate.Validity != ValidityInvalid || invalidCandidate.Valid {
		t.Fatalf("expected explicit invalidity, got %q", invalidCandidate.Validity)
	}
}

func TestExtensionFormsAndURI(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")
	cases := []struct {
		input string
		ext   string
	}{
		{"02079460018x123", "123"},
		{"02079460018#123", "123"},
		{"02079460018 ext: 123", "123"},
		{"tel:+442079460018;ext=123", "123"},
		{"tel:+442079460018;extension=123", "123"},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			result, err := interpreter.Interpret(tc.input)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Interpretations) == 0 {
				t.Fatal("no interpretation")
			}
			candidate := result.Interpretations[0]
			if candidate.Extension != tc.ext {
				t.Errorf("extension = %q, want %q", candidate.Extension, tc.ext)
			}
			if candidate.NationalNumber != "2079460018" {
				t.Errorf("national number = %q", candidate.NationalNumber)
			}
			if !hasEvidence(candidate, EvidenceExtensionMarker) {
				t.Error("missing extension-marker evidence")
			}
		})
	}
}

func TestNationalTrunkAmbiguity(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")
	result, err := interpreter.Interpret("020 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Interpretations) < 2 {
		t.Fatalf("expected trunk and no-trunk interpretations, got %d", len(result.Interpretations))
	}
	trunk := findCandidate(t, result, func(candidate Interpretation) bool {
		return candidate.Kind == KindNationalTrunk
	})
	if trunk.TrunkPrefix != "0" || trunk.NationalNumber != "2079460018" || trunk.E164 != "+442079460018" {
		t.Errorf("trunk candidate = %#v", trunk)
	}
	if trunk.Possibility != PossibilityPossible {
		t.Errorf("trunk possibility = %q", trunk.Possibility)
	}
	noTrunk := findCandidate(t, result, func(candidate Interpretation) bool {
		return candidate.Kind == KindNational
	})
	if noTrunk.TrunkPrefix != "" || noTrunk.NationalNumber != "02079460018" {
		t.Errorf("no-trunk candidate = %#v", noTrunk)
	}
	if noTrunk.Possibility != PossibilityImpossible {
		t.Errorf("no-trunk possibility = %q", noTrunk.Possibility)
	}
}

func TestMetadataSnapshotIsImmutable(t *testing.T) {
	metadata := testMetadata()
	interpreter := mustInterpreter(t, metadata, "GB")
	computedDigest, err := metadata.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if computedDigest != interpreter.MetadataDigest() {
		t.Fatalf("Metadata.Digest() = %q, interpreter digest = %q", computedDigest, interpreter.MetadataDigest())
	}

	before, err := interpreter.Interpret("+44 (0)20 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	beforeCandidate := before.Interpretations[0]
	version := before.MetadataVersion
	digest := before.MetadataDigest
	if version == "" || digest == "" {
		t.Fatal("missing provenance")
	}

	metadata.Regions["GB"] = Region{
		CountryCode:           "99",
		InternationalPrefix:   "77",
		NationalPrefix:        "8",
		NationalNumberLengths: []int{3},
	}

	after, err := interpreter.Interpret("+44 (0)20 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Interpretations) != 1 {
		t.Fatalf("snapshot changed: got %d interpretations", len(after.Interpretations))
	}
	afterCandidate := after.Interpretations[0]
	if afterCandidate.CountryCode != beforeCandidate.CountryCode ||
		afterCandidate.NationalNumber != beforeCandidate.NationalNumber ||
		after.MetadataVersion != version ||
		after.MetadataDigest != digest {
		t.Errorf("old snapshot was rewritten: before=%#v after=%#v", beforeCandidate, afterCandidate)
	}

	nextMetadata := testMetadata()
	nextMetadata.Version = "2027-01"
	next := mustInterpreter(t, nextMetadata, "GB")
	if next.MetadataDigest() == digest {
		t.Error("a different metadata generation should have a different digest")
	}
	nextResult, err := next.Interpret("+44 (0)20 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	if nextResult.MetadataVersion == version {
		t.Error("new generation reused the old version")
	}
	if before.MetadataVersion != version || before.MetadataDigest != digest {
		t.Error("new generation rewrote an old record")
	}
}

func TestMetadataCopyCannotMutateInterpreter(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")
	copy := interpreter.Metadata()
	copy.Regions["GB"] = Region{CountryCode: "99"}

	result, err := interpreter.Interpret("+44 20 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	if result.Interpretations[0].CountryCode != "44" {
		t.Errorf("interpreter metadata was mutated through its copy: %#v", result.Interpretations[0])
	}
}

func TestUnknownCountryCodeIsReported(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")
	result, err := interpreter.Interpret("+999 123 456")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Interpretations) != 0 {
		t.Fatalf("unexpected interpretations: %#v", result.Interpretations)
	}
	found := false
	for _, issue := range result.Issues {
		if issue.Code == IssueUnknownCountryCode {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected unknown-country-code issue, got %#v", result.Issues)
	}
}

func TestNoLengthsMeansUnknownPossibility(t *testing.T) {
	metadata := Metadata{
		Version: "v1",
		Regions: map[string]Region{
			"XX": {CountryCode: "999", NationalPrefix: "0"},
		},
	}
	interpreter := mustInterpreter(t, metadata, "XX")
	result, err := interpreter.Interpret("0 12345")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Interpretations) == 0 {
		t.Fatal("no interpretations")
	}
	for _, candidate := range result.Interpretations {
		if candidate.Possibility != PossibilityUnknown || candidate.Possible {
			t.Errorf("possibility = %q, want unknown", candidate.Possibility)
		}
		if candidate.Validity != ValidityUnknown {
			t.Errorf("validity = %q, want unknown", candidate.Validity)
		}
	}
}

func TestAssumedInternationalPrefixIsMarked(t *testing.T) {
	metadata := Metadata{
		Version: "v1",
		Regions: map[string]Region{
			"GB": {
				CountryCode:           "44",
				NationalPrefix:        "0",
				NationalNumberLengths: []int{10},
			},
		},
	}
	interpreter := mustInterpreter(t, metadata, "GB")

	idd, err := interpreter.Interpret("00442079460018")
	if err != nil {
		t.Fatal(err)
	}
	iddCandidate := findCandidate(t, idd, func(candidate Interpretation) bool {
		return candidate.Kind == KindInternationalIDD
	})
	if !hasEvidence(iddCandidate, EvidenceAssumption) {
		t.Error("fallback exit prefix should be recorded as an assumption")
	}

	plus, err := interpreter.Interpret("+442079460018")
	if err != nil {
		t.Fatal(err)
	}
	for _, candidate := range plus.Interpretations {
		if hasEvidence(candidate, EvidenceAssumption) {
			t.Errorf("plus interpretation must not claim an exit-prefix assumption: %#v", candidate)
		}
	}
}

func TestNoDigitsAndNilInterpreter(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")
	result, err := interpreter.Interpret("not a number")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Interpretations) != 0 || !hasIssue(result, IssueNoDigits) {
		t.Fatalf("unexpected result: %#v", result)
	}

	var nilInterpreter *Interpreter
	if _, err := nilInterpreter.Interpret("+442079460018"); !errors.Is(err, ErrNilInterpreter) {
		t.Fatalf("err = %v, want ErrNilInterpreter", err)
	}
}

func TestLoadMetadataAndJSONShape(t *testing.T) {
	const source = `{
		"version": "2026-11",
		"regions": {
			"GB": {
				"countryCode": "44",
				"internationalPrefix": "00",
				"nationalPrefix": "0",
				"nationalNumberLengths": [10]
			}
		}
	}`
	metadata, err := LoadMetadata(strings.NewReader(source))
	if err != nil {
		t.Fatal(err)
	}
	interpreter := mustInterpreter(t, metadata, "GB")
	result, err := interpreter.Interpret("020 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	if result.Interpretations[0].NationalNumber != "2079460018" {
		t.Errorf("national number = %q", result.Interpretations[0].NationalNumber)
	}
}

func TestResultJSONCarriesProvenanceAndSpans(t *testing.T) {
	interpreter := mustInterpreter(t, testMetadata(), "GB")
	result, err := interpreter.Interpret("+44 (0)20 7946 0018")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["metadataVersion"] != result.MetadataVersion {
		t.Errorf("metadataVersion missing from JSON: %s", encoded)
	}
	if decoded["metadataDigest"] != result.MetadataDigest {
		t.Errorf("metadataDigest missing from JSON: %s", encoded)
	}
	interpretations, ok := decoded["interpretations"].([]any)
	if !ok || len(interpretations) == 0 {
		t.Fatalf("interpretations missing from JSON: %s", encoded)
	}
	candidate, ok := interpretations[0].(map[string]any)
	if !ok {
		t.Fatalf("candidate is not an object: %s", encoded)
	}
	evidence, ok := candidate["evidence"].([]any)
	if !ok || len(evidence) == 0 {
		t.Fatalf("evidence missing from JSON: %s", encoded)
	}
	firstEvidence, ok := evidence[0].(map[string]any)
	if !ok {
		t.Fatalf("evidence is not an object: %s", encoded)
	}
	span, ok := firstEvidence["span"].(map[string]any)
	if !ok {
		t.Fatalf("evidence span missing from JSON: %s", encoded)
	}
	if _, ok := span["start"]; !ok {
		t.Errorf("evidence span start missing from JSON: %s", encoded)
	}
}

func TestInvalidMetadata(t *testing.T) {
	if _, err := NewInterpreter(Metadata{}, "US"); !errors.Is(err, ErrInvalidMetadata) {
		t.Fatalf("empty metadata err = %v", err)
	}
	if _, err := NewInterpreter(testMetadata(), "ZZ"); !errors.Is(err, ErrUnknownDefaultRegion) {
		t.Fatalf("unknown default region err = %v", err)
	}
	bad := Metadata{Regions: map[string]Region{"XX": {CountryCode: "abc"}}}
	if _, err := NewInterpreter(bad, "XX"); !errors.Is(err, ErrInvalidMetadata) {
		t.Fatalf("bad country code err = %v", err)
	}
}

func hasIssue(result Result, code IssueCode) bool {
	for _, issue := range result.Issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}

package dataeng

// Metadata is one generation of numbering-plan metadata. Regions is keyed by
// region identifier (normally an ISO 3166-1 alpha-2 code). Countries is an
// accepted alias for Regions; when both maps contain the same region they must
// describe the same plan.
//
// Version (or its alias Generation) is the caller's generation label. If both
// are empty, the interpreter derives a label from the metadata digest.
type Metadata struct {
	Version    string            `json:"version,omitempty"`
	Generation string            `json:"generation,omitempty"`
	Regions    map[string]Region `json:"regions,omitempty"`
	Countries  map[string]Region `json:"countries,omitempty"`
}

// CountryMetadata is an alias for Metadata.
type CountryMetadata = Metadata

// Region describes the dialing rules that are known for one region. The
// singular and plural prefix fields are combined; this allows compact metadata
// while still supporting regions with more than one trunk or exit prefix.
//
// NationalPrefix, TrunkPrefix, and Trunk are synonyms. NationalNumberLengths,
// PossibleLengths, and NumberLengths are synonyms. ValidNumberPatterns and
// ValidNationalNumberPatterns are synonyms. A valid pattern is matched against
// the complete national significant number; when no pattern is supplied,
// validity remains unknown rather than being inferred from formatting.
type Region struct {
	ID   string `json:"id,omitempty"`
	Code string `json:"code,omitempty"`
	ISO  string `json:"iso,omitempty"`

	CountryCode string `json:"countryCode,omitempty"`
	CallingCode string `json:"callingCode,omitempty"`

	InternationalPrefix   string   `json:"internationalPrefix,omitempty"`
	InternationalPrefixes []string `json:"internationalPrefixes,omitempty"`

	NationalPrefix   string   `json:"nationalPrefix,omitempty"`
	TrunkPrefix      string   `json:"trunkPrefix,omitempty"`
	Trunk            string   `json:"trunk,omitempty"`
	NationalPrefixes []string `json:"nationalPrefixes,omitempty"`
	TrunkPrefixes    []string `json:"trunkPrefixes,omitempty"`

	NationalNumberLengths []int `json:"nationalNumberLengths,omitempty"`
	PossibleLengths       []int `json:"possibleLengths,omitempty"`
	NumberLengths         []int `json:"numberLengths,omitempty"`

	ValidNumberPatterns         []string `json:"validNumberPatterns,omitempty"`
	ValidNationalNumberPatterns []string `json:"validNationalNumberPatterns,omitempty"`
}

// Country is an alias for Region.
type Country = Region

// InterpretationKind identifies how the input was decomposed.
type InterpretationKind string

const (
	// KindInternationalPlus is an explicitly international number beginning
	// with "+".
	KindInternationalPlus InterpretationKind = "international_plus"
	// KindInternationalIDD is an international number beginning with the
	// default region's international direct dialing prefix (for example 00 or
	// 011).
	KindInternationalIDD InterpretationKind = "international_idd"
	// KindInternationalBare is a country code without "+" or an IDD prefix.
	// It is commonly seen when a stored number lost its international marker.
	KindInternationalBare InterpretationKind = "international_bare"
	// KindNationalTrunk is a national number written with its trunk prefix.
	KindNationalTrunk InterpretationKind = "national_trunk"
	// KindNational is a national number written without a trunk prefix.
	KindNational InterpretationKind = "national"
)

// Possibility describes whether the national significant number fits the
// lengths declared by the metadata. It is deliberately separate from
// Validity.
type Possibility string

const (
	// PossibilityUnknown means the metadata does not declare lengths for the
	// region, so no length judgment can be made.
	PossibilityUnknown Possibility = "unknown"
	// PossibilityPossible means the national number length is declared.
	PossibilityPossible Possibility = "possible"
	// PossibilityImpossible means the national number length is not declared.
	PossibilityImpossible Possibility = "impossible"
)

// Validity describes whether the metadata explicitly recognizes the number.
// Parsing and formatting never set ValidityValid.
type Validity string

const (
	ValidityUnknown Validity = "unknown"
	ValidityValid   Validity = "valid"
	ValidityInvalid Validity = "invalid"
)

// Provenance pins a result to the metadata snapshot used to produce it.
type Provenance struct {
	MetadataVersion string `json:"metadataVersion"`
	MetadataDigest  string `json:"metadataDigest"`
}

// Span is a half-open byte interval in the original input.
type Span struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// EvidenceKind identifies the reason a candidate contains a component.
type EvidenceKind string

const (
	EvidenceScheme              EvidenceKind = "scheme"
	EvidenceInternationalPrefix EvidenceKind = "international_prefix"
	EvidenceCountryCode         EvidenceKind = "country_code"
	EvidenceTrunkPrefix         EvidenceKind = "trunk_prefix"
	EvidenceNationalNumber      EvidenceKind = "national_number"
	EvidenceExtensionMarker     EvidenceKind = "extension_marker"
	EvidenceExtension           EvidenceKind = "extension"
	EvidenceRegion              EvidenceKind = "region"
	EvidencePossibility         EvidenceKind = "possibility"
	EvidenceValidity            EvidenceKind = "validity"
	EvidenceAssumption          EvidenceKind = "assumption"
	EvidenceAmbiguity           EvidenceKind = "ambiguity"
)

// Evidence records a token or rule used by one interpretation. Start and End
// refer to byte offsets in the original input. Semantic evidence has an empty
// span.
type Evidence struct {
	Kind    EvidenceKind `json:"kind"`
	Text    string       `json:"text,omitempty"`
	Value   string       `json:"value,omitempty"`
	Span    `json:"span"`
	Message string `json:"message,omitempty"`
}

// Severity classifies a parse issue.
type Severity string

const (
	SeverityWarning Severity = "warning"
	SeverityError   Severity = "error"
)

// IssueCode identifies a non-fatal normalization issue.
type IssueCode string

const (
	IssueNoDigits               IssueCode = "no_digits"
	IssueUnrecognizedCharacters IssueCode = "unrecognized_characters"
	IssueMultiplePlus           IssueCode = "multiple_plus"
	IssueUnbalancedParenthesis  IssueCode = "unbalanced_parenthesis"
	IssueUnknownCountryCode     IssueCode = "unknown_country_code"
	IssueNoInterpretation       IssueCode = "no_interpretation"
	IssueNoDefaultRegion        IssueCode = "no_default_region"
	IssueMetadataAssumption     IssueCode = "metadata_assumption"
)

// Issue explains why part of an input could not be used or why an assumption
// was required. Issues do not by themselves assert that a number is invalid.
type Issue struct {
	Code     IssueCode `json:"code"`
	Severity Severity  `json:"severity"`
	Message  string    `json:"message"`
	Span     `json:"span"`
}

// Parts is a compact view of the five components distinguished by the
// interpreter.
type Parts struct {
	InternationalPrefix string `json:"internationalPrefix,omitempty"`
	CountryCode         string `json:"countryCode,omitempty"`
	TrunkPrefix         string `json:"trunkPrefix,omitempty"`
	NationalNumber      string `json:"nationalNumber,omitempty"`
	Extension           string `json:"extension,omitempty"`
}

// Interpretation is one structural explanation of the input.
//
// WellFormed means the components were recognized. Possibility and Validity
// are independent judgments: a well-formed number can be impossible, and a
// possible number can have unknown validity. Valid is a convenience boolean
// that is true only when Validity is ValidityValid.
type Interpretation struct {
	Provenance

	Kind InterpretationKind `json:"kind"`

	Region           string   `json:"region"`
	RegionCandidates []string `json:"regionCandidates,omitempty"`
	RegionAmbiguous  bool     `json:"regionAmbiguous,omitempty"`

	CountryCode         string `json:"countryCode,omitempty"`
	CountryCodeInferred bool   `json:"countryCodeInferred,omitempty"`
	InternationalPrefix string `json:"internationalPrefix,omitempty"`
	TrunkPrefix         string `json:"trunkPrefix,omitempty"`
	NationalPrefix      string `json:"nationalPrefix,omitempty"`
	NationalNumber      string `json:"nationalNumber,omitempty"`

	// NationalSignificantNumber is an alias for NationalNumber.
	NationalSignificantNumber string `json:"nationalSignificantNumber,omitempty"`

	Extension          string      `json:"extension,omitempty"`
	ExtensionMarker    string      `json:"extensionMarker,omitempty"`
	TrunkParenthesized bool        `json:"trunkParenthesized,omitempty"`
	WellFormed         bool        `json:"wellFormed"`
	Possibility        Possibility `json:"possibility"`
	Possible           bool        `json:"possible"`
	Validity           Validity    `json:"validity"`
	Valid              bool        `json:"valid"`
	E164               string      `json:"e164,omitempty"`
	RFC3966            string      `json:"rfc3966,omitempty"`

	Parts    Parts      `json:"parts"`
	Evidence []Evidence `json:"evidence,omitempty"`
	Warnings []string   `json:"warnings,omitempty"`
}

// Result is the complete output of one interpretation pass. Interpretations
// contains every structurally distinct explanation supported by the snapshot.
type Result struct {
	Provenance

	Input           string           `json:"input"`
	DefaultRegion   string           `json:"defaultRegion,omitempty"`
	Interpretations []Interpretation `json:"interpretations"`
	Issues          []Issue          `json:"issues,omitempty"`
}

// All returns a copy of every interpretation.
func (r Result) All() []Interpretation {
	out := make([]Interpretation, len(r.Interpretations))
	copy(out, r.Interpretations)
	return out
}

// Candidates is an alias for All.
func (r Result) Candidates() []Interpretation {
	return r.All()
}

// PossibleCandidates returns the interpretations whose national number length
// is declared by the metadata.
func (r Result) PossibleCandidates() []Interpretation {
	out := make([]Interpretation, 0, len(r.Interpretations))
	for _, interpretation := range r.Interpretations {
		if interpretation.Possibility == PossibilityPossible {
			out = append(out, interpretation)
		}
	}
	return out
}

// Best returns the strongest candidate. A possible candidate that is not
// explicitly invalid is preferred, followed by a non-impossible candidate, and
// finally the first structurally recognized candidate.
func (r Result) Best() (Interpretation, bool) {
	for _, interpretation := range r.Interpretations {
		if interpretation.Possibility == PossibilityPossible && interpretation.Validity != ValidityInvalid {
			return interpretation, true
		}
	}
	for _, interpretation := range r.Interpretations {
		if interpretation.Possibility != PossibilityImpossible && interpretation.Validity != ValidityInvalid {
			return interpretation, true
		}
	}
	if len(r.Interpretations) > 0 {
		return r.Interpretations[0], true
	}
	return Interpretation{}, false
}

// IsPossible reports whether the metadata declares the national number length.
func (i Interpretation) IsPossible() bool {
	return i.Possibility == PossibilityPossible
}

// IsValid reports whether metadata validation explicitly accepted the number.
func (i Interpretation) IsValid() bool {
	return i.Validity == ValidityValid
}

// String returns the E.164 form when one can be constructed.
func (i Interpretation) String() string {
	return i.E164
}

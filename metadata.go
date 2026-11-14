package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
)

var (
	// ErrInvalidMetadata is returned when a metadata snapshot cannot be
	// normalized safely.
	ErrInvalidMetadata = errors.New("dataeng: invalid metadata")
	// ErrUnknownDefaultRegion is returned when the requested default region is
	// absent from the metadata.
	ErrUnknownDefaultRegion = errors.New("dataeng: unknown default region")
	// ErrNilInterpreter is returned when a nil interpreter is used.
	ErrNilInterpreter = errors.New("dataeng: nil interpreter")
)

type plan struct {
	region Region

	internationalPrefixes []string
	internationalAssumed  bool
	trunkPrefixes         []string
	lengths               []int
	validPatterns         []*regexp.Regexp
	validPatternStrings   []string
}

type snapshot struct {
	version string
	digest  string

	regions map[string]*plan
	order   []string
	byCC    map[string][]string
}

// Interpreter holds an immutable metadata snapshot. It is safe for concurrent
// use.
type Interpreter struct {
	snapshot      *snapshot
	defaultRegion string
}

// PhoneInterpreter is an alias for Interpreter.
type PhoneInterpreter = Interpreter

// NewInterpreter freezes metadata and binds it to defaultRegion. The metadata
// argument accepts Metadata, *Metadata, or map[string]Region. Passing an
// unknown non-empty default region is an error. An empty default region is
// allowed for explicitly international analysis.
func NewInterpreter(metadata any, defaultRegion string) (*Interpreter, error) {
	snap, err := freezeMetadata(metadata)
	if err != nil {
		return nil, err
	}

	region := normalizeRegionID(defaultRegion)
	if region != "" {
		if _, ok := snap.regions[region]; !ok {
			return nil, fmt.Errorf("%w: %q", ErrUnknownDefaultRegion, defaultRegion)
		}
	}

	return &Interpreter{snapshot: snap, defaultRegion: region}, nil
}

// New is an alias for NewInterpreter.
func New(metadata any, defaultRegion string) (*Interpreter, error) {
	return NewInterpreter(metadata, defaultRegion)
}

// MetadataVersion returns the generation label of the frozen snapshot.
func (i *Interpreter) MetadataVersion() string {
	if i == nil || i.snapshot == nil {
		return ""
	}
	return i.snapshot.version
}

// MetadataDigest returns the digest of the frozen snapshot.
func (i *Interpreter) MetadataDigest() string {
	if i == nil || i.snapshot == nil {
		return ""
	}
	return i.snapshot.digest
}

// DefaultRegion returns the normalized default region.
func (i *Interpreter) DefaultRegion() string {
	if i == nil {
		return ""
	}
	return i.defaultRegion
}

// Metadata returns a deep copy of the normalized metadata snapshot. Mutating
// the copy does not affect the interpreter.
func (i *Interpreter) Metadata() Metadata {
	if i == nil || i.snapshot == nil {
		return Metadata{}
	}
	regions := make(map[string]Region, len(i.snapshot.regions))
	for id, p := range i.snapshot.regions {
		regions[id] = cloneRegion(p.region)
	}
	return Metadata{Version: i.snapshot.version, Regions: regions}
}

// Digest computes the digest that would identify this metadata content.
func (m Metadata) Digest() (string, error) {
	snap, err := freezeMetadata(m)
	if err != nil {
		return "", err
	}
	return snap.digest, nil
}

// LoadMetadata decodes one metadata generation from JSON.
func LoadMetadata(r io.Reader) (Metadata, error) {
	var metadata Metadata
	decoder := json.NewDecoder(r)
	if err := decoder.Decode(&metadata); err != nil {
		return Metadata{}, fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	}
	return metadata, nil
}

func freezeMetadata(input any) (*snapshot, error) {
	var metadata Metadata
	switch value := input.(type) {
	case Metadata:
		metadata = value
	case *Metadata:
		if value == nil {
			return nil, fmt.Errorf("%w: nil *Metadata", ErrInvalidMetadata)
		}
		metadata = *value
	case map[string]Region:
		metadata = Metadata{Regions: value}
	default:
		return nil, fmt.Errorf("%w: unsupported metadata type %T", ErrInvalidMetadata, input)
	}

	regions := make(map[string]Region)
	if err := mergeRegionMap(regions, metadata.Regions); err != nil {
		return nil, err
	}
	if err := mergeRegionMap(regions, metadata.Countries); err != nil {
		return nil, err
	}
	if len(regions) == 0 {
		return nil, fmt.Errorf("%w: no regions", ErrInvalidMetadata)
	}

	order := make([]string, 0, len(regions))
	for id := range regions {
		order = append(order, id)
	}
	sort.Strings(order)

	snap := &snapshot{
		regions: make(map[string]*plan, len(regions)),
		order:   order,
		byCC:    make(map[string][]string),
	}

	for _, id := range order {
		p, err := buildPlan(id, regions[id])
		if err != nil {
			return nil, err
		}
		snap.regions[id] = p
		snap.byCC[p.region.CountryCode] = append(snap.byCC[p.region.CountryCode], id)
	}
	for cc := range snap.byCC {
		sort.Strings(snap.byCC[cc])
	}

	version := strings.TrimSpace(metadata.Version)
	if version == "" {
		version = strings.TrimSpace(metadata.Generation)
	}
	canonical := canonicalMetadata(version, order, snap.regions)
	encoded, err := json.Marshal(canonical)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidMetadata, err)
	}
	sum := sha256.Sum256(encoded)
	digest := hex.EncodeToString(sum[:])
	snap.digest = "sha256:" + digest
	snap.version = version
	if snap.version == "" {
		snap.version = snap.digest
	}
	return snap, nil
}

func mergeRegionMap(dst, src map[string]Region) error {
	for rawID, region := range src {
		id := normalizeRegionID(rawID)
		if id == "" {
			return fmt.Errorf("%w: empty region identifier", ErrInvalidMetadata)
		}
		if existing, ok := dst[id]; ok {
			if !regionsEqual(existing, region) {
				return fmt.Errorf("%w: conflicting definitions for region %s", ErrInvalidMetadata, id)
			}
			continue
		}
		dst[id] = region
	}
	return nil
}

func buildPlan(id string, region Region) (*plan, error) {
	region = cloneRegion(region)

	if region.ID == "" {
		region.ID = id
	} else if normalizeRegionID(region.ID) != id {
		return nil, fmt.Errorf("%w: region %s declares identifier %q", ErrInvalidMetadata, id, region.ID)
	}
	for _, alias := range []string{region.Code, region.ISO} {
		if alias != "" && normalizeRegionID(alias) != id {
			return nil, fmt.Errorf("%w: region %s declares conflicting identifier %q", ErrInvalidMetadata, id, alias)
		}
	}
	region.ID = id

	countryCode := region.CountryCode
	if countryCode == "" {
		countryCode = region.CallingCode
	} else if region.CallingCode != "" && normalizeDigits(region.CallingCode) != normalizeDigits(countryCode) {
		return nil, fmt.Errorf("%w: region %s declares conflicting country codes", ErrInvalidMetadata, id)
	}
	cc, err := normalizePhoneDigits(countryCode)
	if err != nil || cc == "" {
		return nil, fmt.Errorf("%w: region %s has invalid country code %q", ErrInvalidMetadata, id, countryCode)
	}
	if len(cc) > 3 {
		return nil, fmt.Errorf("%w: region %s country code is longer than 3 digits", ErrInvalidMetadata, id)
	}
	region.CountryCode = cc
	region.CallingCode = cc

	idds, err := normalizePrefixList(id, "international prefix", region.InternationalPrefix, "", region.InternationalPrefixes...)
	if err != nil {
		return nil, err
	}
	assumed := false
	if len(idds) == 0 {
		assumed = true
		if cc == "1" {
			idds = []string{"011"}
		} else {
			idds = []string{"00"}
		}
	}
	sort.Slice(idds, func(a, b int) bool {
		if len(idds[a]) != len(idds[b]) {
			return len(idds[a]) > len(idds[b])
		}
		return idds[a] < idds[b]
	})

	trunkValues := append([]string{region.NationalPrefix, region.TrunkPrefix, region.Trunk}, region.NationalPrefixes...)
	trunkValues = append(trunkValues, region.TrunkPrefixes...)
	trunks, err := normalizePrefixList(id, "trunk prefix", "", "", trunkValues...)
	if err != nil {
		return nil, err
	}
	sort.Slice(trunks, func(a, b int) bool {
		if len(trunks[a]) != len(trunks[b]) {
			return len(trunks[a]) > len(trunks[b])
		}
		return trunks[a] < trunks[b]
	})

	lengths := append([]int(nil), region.NationalNumberLengths...)
	lengths = append(lengths, region.PossibleLengths...)
	lengths = append(lengths, region.NumberLengths...)
	lengths = uniqueLengths(lengths)
	for _, length := range lengths {
		if length <= 0 || length > 20 {
			return nil, fmt.Errorf("%w: region %s has invalid national number length %d", ErrInvalidMetadata, id, length)
		}
	}
	sort.Ints(lengths)

	patternStrings := append([]string(nil), region.ValidNumberPatterns...)
	patternStrings = append(patternStrings, region.ValidNationalNumberPatterns...)
	patternStrings = uniqueStrings(patternStrings)
	patterns := make([]*regexp.Regexp, 0, len(patternStrings))
	for _, source := range patternStrings {
		compiled, err := regexp.Compile("^(?:" + source + ")$")
		if err != nil {
			return nil, fmt.Errorf("%w: region %s has invalid number pattern: %v", ErrInvalidMetadata, id, err)
		}
		patterns = append(patterns, compiled)
	}
	sort.Strings(patternStrings)

	region.InternationalPrefix = ""
	if len(idds) > 0 {
		region.InternationalPrefix = idds[0]
	}
	region.InternationalPrefixes = append([]string(nil), idds...)
	region.NationalPrefix = ""
	if len(trunks) > 0 {
		region.NationalPrefix = trunks[0]
	}
	region.TrunkPrefix = region.NationalPrefix
	region.Trunk = region.NationalPrefix
	region.NationalPrefixes = append([]string(nil), trunks...)
	region.TrunkPrefixes = append([]string(nil), trunks...)
	region.NationalNumberLengths = append([]int(nil), lengths...)
	region.PossibleLengths = append([]int(nil), lengths...)
	region.NumberLengths = append([]int(nil), lengths...)
	region.ValidNumberPatterns = append([]string(nil), patternStrings...)
	region.ValidNationalNumberPatterns = append([]string(nil), patternStrings...)

	return &plan{
		region:                region,
		internationalPrefixes: idds,
		internationalAssumed:  assumed,
		trunkPrefixes:         trunks,
		lengths:               lengths,
		validPatterns:         patterns,
		validPatternStrings:   patternStrings,
	}, nil
}

func canonicalMetadata(version string, order []string, regions map[string]*plan) any {
	type canonicalRegion struct {
		ID                         string   `json:"id"`
		CountryCode                string   `json:"countryCode"`
		InternationalPrefixes      []string `json:"internationalPrefixes"`
		InternationalPrefixAssumed bool     `json:"internationalPrefixAssumed"`
		TrunkPrefixes              []string `json:"trunkPrefixes"`
		NationalNumberLengths      []int    `json:"nationalNumberLengths"`
		ValidNumberPatterns        []string `json:"validNumberPatterns"`
	}
	type canonical struct {
		Version string            `json:"version"`
		Regions []canonicalRegion `json:"regions"`
	}

	out := canonical{Version: version, Regions: make([]canonicalRegion, 0, len(order))}
	for _, id := range order {
		p := regions[id]
		out.Regions = append(out.Regions, canonicalRegion{
			ID:                         id,
			CountryCode:                p.region.CountryCode,
			InternationalPrefixes:      append([]string{}, p.internationalPrefixes...),
			InternationalPrefixAssumed: p.internationalAssumed,
			TrunkPrefixes:              append([]string{}, p.trunkPrefixes...),
			NationalNumberLengths:      append([]int{}, p.lengths...),
			ValidNumberPatterns:        append([]string{}, p.validPatternStrings...),
		})
	}
	return out
}

func cloneRegion(region Region) Region {
	region.InternationalPrefixes = append([]string(nil), region.InternationalPrefixes...)
	region.NationalPrefixes = append([]string(nil), region.NationalPrefixes...)
	region.TrunkPrefixes = append([]string(nil), region.TrunkPrefixes...)
	region.NationalNumberLengths = append([]int(nil), region.NationalNumberLengths...)
	region.PossibleLengths = append([]int(nil), region.PossibleLengths...)
	region.NumberLengths = append([]int(nil), region.NumberLengths...)
	region.ValidNumberPatterns = append([]string(nil), region.ValidNumberPatterns...)
	region.ValidNationalNumberPatterns = append([]string(nil), region.ValidNationalNumberPatterns...)
	return region
}

func regionsEqual(a, b Region) bool {
	left, err := json.Marshal(cloneRegion(a))
	if err != nil {
		return false
	}
	right, err := json.Marshal(cloneRegion(b))
	if err != nil {
		return false
	}
	return string(left) == string(right)
}

func normalizeRegionID(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func normalizePhoneDigits(value string) (string, error) {
	var builder strings.Builder
	for _, r := range strings.TrimSpace(value) {
		switch {
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '+' || r == '-' || r == '(' || r == ')' || r == ' ' || r == '\t':
			continue
		default:
			return "", fmt.Errorf("non-digit %q", r)
		}
	}
	return builder.String(), nil
}

func normalizeDigits(value string) string {
	digits, _ := normalizePhoneDigits(value)
	return digits
}

func normalizePrefixList(region, label, singular, alternate string, plural ...string) ([]string, error) {
	values := make([]string, 0, len(plural)+2)
	for _, value := range append([]string{singular, alternate}, plural...) {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		normalized, err := normalizePhoneDigits(value)
		if err != nil || normalized == "" {
			return nil, fmt.Errorf("%w: region %s has invalid %s %q", ErrInvalidMetadata, region, label, value)
		}
		values = append(values, normalized)
	}
	return uniqueStrings(values), nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func uniqueLengths(values []int) []int {
	seen := make(map[int]struct{}, len(values))
	out := make([]int, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func isASCIILetter(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

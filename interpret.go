package dataeng

import (
	"sort"
	"strconv"
	"strings"
)

type countryCodeMatch struct {
	code    string
	start   int
	end     int
	regions []string
}

type candidateKey struct {
	kind            InterpretationKind
	international   string
	countryCode     string
	countryInferred bool
	trunk           string
	nsn             string
	extension       string
	possibility     Possibility
	validity        Validity
	trunkParen      bool
}

// Interpret returns all structural interpretations that the frozen metadata
// supports. Malformed input is reported through Result.Issues; it is not a
// validity decision and does not produce an error.
func (i *Interpreter) Interpret(input string) (Result, error) {
	if i == nil || i.snapshot == nil {
		return Result{}, ErrNilInterpreter
	}

	p := prepareInput(input)
	result := Result{
		Provenance:    Provenance{MetadataVersion: i.snapshot.version, MetadataDigest: i.snapshot.digest},
		Input:         input,
		DefaultRegion: i.defaultRegion,
		Issues:        append([]Issue(nil), p.issues...),
	}

	if len(p.digits) == 0 {
		result.Issues = append(result.Issues, issue(
			IssueNoDigits, SeverityError, Span{Start: p.mainStart, End: p.mainEnd},
			"input contains no telephone digits",
		))
		return result, nil
	}

	var candidates []Interpretation
	if p.plus {
		if len(i.snapshot.countryCodeMatches(p.digits, 0)) == 0 {
			count := len(p.digits)
			if count > 3 {
				count = 3
			}
			result.Issues = append(result.Issues, issue(
				IssueUnknownCountryCode, SeverityError, digitSpan(p.digits, 0, count),
				"leading digits %q do not match a country code in metadata version %s",
				digitsString(p.digits, 0, count), i.snapshot.version,
			))
		}
		candidates = append(candidates, i.internationalPlus(p)...)
	} else {
		result.Issues = append(result.Issues, i.internationalIDDIssues(p)...)
		candidates = append(candidates, i.internationalIDD(p)...)
		candidates = append(candidates, i.national(p)...)
		candidates = append(candidates, i.internationalBare(p)...)
	}

	candidates = i.mergeEquivalent(candidates, i.defaultRegion)
	sortCandidates(candidates)

	if candidatesUseAssumption(candidates) {
		result.Issues = append(result.Issues, issue(
			IssueMetadataAssumption, SeverityWarning, Span{},
			"interpretation relies on an international prefix that was not declared by the metadata",
		))
	}

	if len(candidates) == 0 {
		if i.defaultRegion == "" {
			result.Issues = append(result.Issues, issue(
				IssueNoDefaultRegion, SeverityWarning, Span{},
				"no default region was supplied and no explicitly international interpretation was possible",
			))
		}
		result.Issues = append(result.Issues, issue(
			IssueNoInterpretation, SeverityError, Span{Start: p.mainStart, End: p.mainEnd},
			"no interpretation is supported by the metadata",
		))
	}
	result.Interpretations = candidates
	return result, nil
}

func candidatesUseAssumption(candidates []Interpretation) bool {
	for _, candidate := range candidates {
		for _, evidence := range candidate.Evidence {
			if evidence.Kind == EvidenceAssumption {
				return true
			}
		}
	}
	return false
}

// Parse is an alias for Interpret.
func (i *Interpreter) Parse(input string) (Result, error) {
	return i.Interpret(input)
}

// Explain is an alias for Interpret.
func (i *Interpreter) Explain(input string) (Result, error) {
	return i.Interpret(input)
}

// Candidates returns only the interpretation list.
func (i *Interpreter) Candidates(input string) ([]Interpretation, error) {
	result, err := i.Interpret(input)
	if err != nil {
		return nil, err
	}
	return result.Interpretations, nil
}

// InterpretAll is an alias for Candidates.
func (i *Interpreter) InterpretAll(input string) ([]Interpretation, error) {
	return i.Candidates(input)
}

// ParseAll is an alias for Candidates.
func (i *Interpreter) ParseAll(input string) ([]Interpretation, error) {
	return i.Candidates(input)
}

func (i *Interpreter) internationalPlus(p preparedInput) []Interpretation {
	var out []Interpretation
	matches := i.snapshot.countryCodeMatches(p.digits, 0)
	if len(matches) == 0 {
		return out
	}

	prefixSpan := Span{Start: p.plusPos, End: p.plusPos + 1}
	for _, match := range matches {
		for _, regionID := range match.regions {
			out = append(out, i.countryVariants(
				p, KindInternationalPlus, "+", prefixSpan, match, regionID, true,
			)...)
		}
	}
	return out
}

func (i *Interpreter) internationalIDD(p preparedInput) []Interpretation {
	if i.defaultRegion == "" {
		return nil
	}
	plan := i.snapshot.regions[i.defaultRegion]
	if plan == nil {
		return nil
	}

	var out []Interpretation
	for _, idd := range plan.internationalPrefixes {
		if idd == "" || !digitPrefixMatches(p.digits, 0, idd) {
			continue
		}
		prefixSpan := digitSpan(p.digits, 0, len(idd))
		matches := i.snapshot.countryCodeMatches(p.digits, len(idd))
		for _, match := range matches {
			for _, regionID := range match.regions {
				out = append(out, i.countryVariants(
					p, KindInternationalIDD, idd, prefixSpan, match, regionID, true,
				)...)
			}
		}
	}
	return out
}

func (i *Interpreter) internationalIDDIssues(p preparedInput) []Issue {
	if i.defaultRegion == "" {
		return nil
	}
	plan := i.snapshot.regions[i.defaultRegion]
	if plan == nil {
		return nil
	}

	matchedPrefix := false
	matchedCountryCode := false
	longest := ""
	for _, idd := range plan.internationalPrefixes {
		if idd == "" || !digitPrefixMatches(p.digits, 0, idd) {
			continue
		}
		matchedPrefix = true
		if len(idd) > len(longest) {
			longest = idd
		}
		if len(i.snapshot.countryCodeMatches(p.digits, len(idd))) > 0 {
			matchedCountryCode = true
		}
	}
	if !matchedPrefix || matchedCountryCode {
		return nil
	}
	count := len(p.digits) - len(longest)
	if count > 3 {
		count = 3
	}
	if count <= 0 {
		return nil
	}
	return []Issue{issue(
		IssueUnknownCountryCode, SeverityError, digitSpan(p.digits, len(longest), count),
		"digits after international prefix %q do not match a country code in metadata version %s",
		longest, i.snapshot.version,
	)}
}

func (i *Interpreter) internationalBare(p preparedInput) []Interpretation {
	var out []Interpretation
	matches := i.snapshot.countryCodeMatches(p.digits, 0)
	for _, match := range matches {
		for _, regionID := range match.regions {
			out = append(out, i.countryVariants(
				p, KindInternationalBare, "", Span{}, match, regionID, true,
			)...)
		}
	}
	return out
}

func (i *Interpreter) countryVariants(
	p preparedInput,
	kind InterpretationKind,
	internationalPrefix string,
	prefixSpan Span,
	match countryCodeMatch,
	regionID string,
	allowStrict bool,
) []Interpretation {
	plan := i.snapshot.regions[regionID]
	if plan == nil || match.end >= len(p.digits) {
		return nil
	}

	var out []Interpretation
	trunkMatchedParenthesized := false

	for _, trunk := range plan.trunkPrefixes {
		if !digitPrefixMatches(p.digits, match.end, trunk) {
			continue
		}
		nsnStart := match.end + len(trunk)
		if nsnStart >= len(p.digits) {
			continue
		}
		trunkSpan := digitSpan(p.digits, match.end, len(trunk))
		parenthesized := allInParentheses(p.digits, match.end, len(trunk))
		if parenthesized {
			trunkMatchedParenthesized = true
		}
		out = append(out, i.makeInterpretation(
			p, kind, internationalPrefix, prefixSpan, match, regionID,
			digitText(p.raw, p.digits, match.end, len(trunk)),
			trunkSpan, trunk, digitsString(p.digits, nsnStart, len(p.digits)-nsnStart),
			digitSpan(p.digits, nsnStart, len(p.digits)-nsnStart), parenthesized,
			plan.internationalAssumed && kind == KindInternationalIDD,
		))
	}

	if allowStrict && !trunkMatchedParenthesized {
		nsnStart := match.end
		out = append(out, i.makeInterpretation(
			p, kind, internationalPrefix, prefixSpan, match, regionID,
			"", Span{}, "", digitsString(p.digits, nsnStart, len(p.digits)-nsnStart),
			digitSpan(p.digits, nsnStart, len(p.digits)-nsnStart), false,
			plan.internationalAssumed && kind == KindInternationalIDD,
		))
	}
	return out
}

func (i *Interpreter) national(p preparedInput) []Interpretation {
	if i.defaultRegion == "" {
		return nil
	}
	plan := i.snapshot.regions[i.defaultRegion]
	if plan == nil {
		return nil
	}

	var out []Interpretation
	trunkMatchedParenthesized := false
	for _, trunk := range plan.trunkPrefixes {
		if !digitPrefixMatches(p.digits, 0, trunk) {
			continue
		}
		nsnStart := len(trunk)
		if nsnStart >= len(p.digits) {
			continue
		}
		parenthesized := allInParentheses(p.digits, 0, len(trunk))
		if parenthesized {
			trunkMatchedParenthesized = true
		}
		out = append(out, i.makeInterpretation(
			p, KindNationalTrunk, "", Span{},
			countryCodeMatch{code: plan.region.CountryCode, start: 0, end: 0, regions: []string{i.defaultRegion}},
			i.defaultRegion,
			digitText(p.raw, p.digits, 0, len(trunk)), digitSpan(p.digits, 0, len(trunk)),
			trunk, digitsString(p.digits, nsnStart, len(p.digits)-nsnStart),
			digitSpan(p.digits, nsnStart, len(p.digits)-nsnStart), parenthesized, false,
		))
	}

	if !trunkMatchedParenthesized {
		out = append(out, i.makeInterpretation(
			p, KindNational, "", Span{},
			countryCodeMatch{code: plan.region.CountryCode, start: 0, end: 0, regions: []string{i.defaultRegion}},
			i.defaultRegion,
			"", Span{}, "", digitsString(p.digits, 0, len(p.digits)),
			digitSpan(p.digits, 0, len(p.digits)), false, false,
		))
	}
	return out
}

func (i *Interpreter) makeInterpretation(
	p preparedInput,
	kind InterpretationKind,
	internationalPrefix string,
	prefixSpan Span,
	match countryCodeMatch,
	regionID string,
	trunkText string,
	trunkSpan Span,
	trunk string,
	nsn string,
	nsnSpan Span,
	trunkParenthesized bool,
	assumedInternational bool,
) Interpretation {
	plan := i.snapshot.regions[regionID]
	cc := match.code
	inferred := kind == KindNational || kind == KindNationalTrunk

	if cc == "" && plan != nil {
		cc = plan.region.CountryCode
	}

	possibility := PossibilityUnknown
	possibilityMessage := "metadata does not declare national-number lengths"
	if plan != nil && len(plan.lengths) > 0 {
		possibility = PossibilityImpossible
		if containsInt(plan.lengths, len(nsn)) {
			possibility = PossibilityPossible
			possibilityMessage = "national number length " + strconv.Itoa(len(nsn)) + " is declared for " + regionID
		} else {
			possibilityMessage = "national number length " + strconv.Itoa(len(nsn)) + " is not declared for " + regionID +
				"; declared lengths: " + joinInts(plan.lengths)
		}
	}

	validity := ValidityUnknown
	validityMessage := "metadata does not declare validity patterns"
	if plan != nil && len(plan.validPatterns) > 0 {
		validity = ValidityInvalid
		for _, pattern := range plan.validPatterns {
			if pattern.MatchString(nsn) {
				validity = ValidityValid
				break
			}
		}
		if validity == ValidityValid {
			validityMessage = "national number matches a declared validity pattern"
		} else {
			validityMessage = "national number does not match any declared validity pattern"
		}
	}

	evidence := make([]Evidence, 0, 9)
	if p.hasScheme {
		evidence = append(evidence, Evidence{
			Kind: EvidenceScheme, Text: prefixText(p.raw, p.schemeSpan),
			Value: prefixText(p.raw, p.schemeSpan), Span: p.schemeSpan,
			Message: "URI scheme removed before number analysis",
		})
	}
	if internationalPrefix != "" {
		evidence = append(evidence, Evidence{
			Kind: EvidenceInternationalPrefix, Text: prefixText(p.raw, prefixSpan),
			Value: internationalPrefix, Span: prefixSpan,
			Message: internationalPrefixMessage(kind, assumedInternational),
		})
		if assumedInternational {
			evidence = append(evidence, Evidence{
				Kind:    EvidenceAssumption,
				Value:   internationalPrefix,
				Message: "international prefix was not declared by the metadata and was derived from the country code",
			})
		}
	}
	if match.end > match.start {
		evidence = append(evidence, Evidence{
			Kind: EvidenceCountryCode, Text: digitText(p.raw, p.digits, match.start, match.end-match.start),
			Value: cc, Span: digitSpan(p.digits, match.start, match.end-match.start),
			Message: "country code matched " + strings.Join(match.regions, ", "),
		})
	} else if cc != "" {
		evidence = append(evidence, Evidence{
			Kind: EvidenceCountryCode, Value: cc,
			Message: "country code inferred from default region " + regionID,
		})
	}
	if trunk != "" {
		message := "national trunk prefix is not part of the national significant number"
		if trunkParenthesized {
			message = "parenthesized national trunk prefix is not part of the national significant number"
		} else if kind == KindInternationalPlus || kind == KindInternationalIDD {
			message = "national trunk prefix appears after the country code and is not part of the national significant number"
		}
		evidence = append(evidence, Evidence{
			Kind: EvidenceTrunkPrefix, Text: trunkText, Value: trunk, Span: trunkSpan, Message: message,
		})
	}
	if nsn != "" {
		evidence = append(evidence, Evidence{
			Kind: EvidenceNationalNumber, Text: prefixText(p.raw, nsnSpan), Value: nsn, Span: nsnSpan,
		})
	}
	if p.hasExt {
		evidence = append(evidence, Evidence{
			Kind: EvidenceExtensionMarker, Text: prefixText(p.raw, p.ext.markerSpan),
			Value: p.ext.marker, Span: p.ext.markerSpan,
			Message: "extension marker excluded from the telephone number",
		})
		evidence = append(evidence, Evidence{
			Kind: EvidenceExtension, Value: p.ext.digits, Span: p.ext.digitsSpan,
			Text: prefixText(p.raw, p.ext.digitsSpan),
		})
	}
	regionMessage := "region plan used for interpretation"
	if len(match.regions) > 1 {
		regionMessage += "; candidate regions: " + strings.Join(match.regions, ", ")
	}
	evidence = append(evidence, Evidence{
		Kind: EvidenceRegion, Value: regionID, Message: regionMessage,
	})
	if len(match.regions) > 1 {
		evidence = append(evidence, Evidence{
			Kind: EvidenceAmbiguity, Value: strings.Join(match.regions, ","),
			Message: "country code is shared by multiple region plans",
		})
	}
	evidence = append(evidence, Evidence{
		Kind: EvidencePossibility, Value: string(possibility), Message: possibilityMessage,
	})
	evidence = append(evidence, Evidence{
		Kind: EvidenceValidity, Value: string(validity), Message: validityMessage,
	})

	e164 := ""
	if cc != "" && nsn != "" {
		e164 = "+" + cc + nsn
	}
	rfc3966 := ""
	if e164 != "" {
		rfc3966 = "tel:" + e164
		if p.hasExt {
			rfc3966 += ";ext=" + p.ext.digits
		}
	}

	extension := ""
	extensionMarker := ""
	if p.hasExt {
		extension = p.ext.digits
		extensionMarker = p.ext.marker
	}
	parts := Parts{
		InternationalPrefix: internationalPrefix,
		CountryCode:         cc,
		TrunkPrefix:         trunk,
		NationalNumber:      nsn,
		Extension:           extension,
	}

	return Interpretation{
		Provenance:                Provenance{MetadataVersion: i.snapshot.version, MetadataDigest: i.snapshot.digest},
		Kind:                      kind,
		Region:                    regionID,
		RegionCandidates:          append([]string(nil), match.regions...),
		CountryCode:               cc,
		CountryCodeInferred:       inferred,
		InternationalPrefix:       internationalPrefix,
		TrunkPrefix:               trunk,
		NationalPrefix:            trunk,
		NationalNumber:            nsn,
		NationalSignificantNumber: nsn,
		Extension:                 extension,
		ExtensionMarker:           extensionMarker,
		TrunkParenthesized:        trunkParenthesized,
		WellFormed:                true,
		Possibility:               possibility,
		Possible:                  possibility == PossibilityPossible,
		Validity:                  validity,
		Valid:                     validity == ValidityValid,
		E164:                      e164,
		RFC3966:                   rfc3966,
		Parts:                     parts,
		Evidence:                  evidence,
	}
}

func (i *Interpreter) mergeEquivalent(candidates []Interpretation, preferredRegion string) []Interpretation {
	index := make(map[candidateKey]int, len(candidates))
	out := make([]Interpretation, 0, len(candidates))

	for _, candidate := range candidates {
		key := candidateKey{
			kind:            candidate.Kind,
			international:   candidate.InternationalPrefix,
			countryCode:     candidate.CountryCode,
			countryInferred: candidate.CountryCodeInferred,
			trunk:           candidate.TrunkPrefix,
			nsn:             candidate.NationalNumber,
			extension:       candidate.Extension,
			possibility:     candidate.Possibility,
			validity:        candidate.Validity,
			trunkParen:      candidate.TrunkParenthesized,
		}
		if at, ok := index[key]; ok {
			mergeRegions(&out[at], candidate, preferredRegion)
			continue
		}
		candidate.RegionCandidates = uniqueSorted(candidate.RegionCandidates)
		candidate.RegionAmbiguous = len(candidate.RegionCandidates) > 1
		index[key] = len(out)
		out = append(out, candidate)
	}
	return out
}

func mergeRegions(target *Interpretation, other Interpretation, preferredRegion string) {
	regions := uniqueSorted(append(append([]string(nil), target.RegionCandidates...), other.RegionCandidates...))
	if len(regions) == 0 {
		regions = uniqueSorted([]string{target.Region, other.Region})
	}
	target.RegionCandidates = regions
	target.RegionAmbiguous = len(regions) > 1
	if preferredRegion != "" && containsString(regions, preferredRegion) {
		target.Region = preferredRegion
	} else if !containsString(regions, target.Region) && len(regions) > 0 {
		target.Region = regions[0]
	}

	copied := false
	for index := range target.Evidence {
		if target.Evidence[index].Kind != EvidenceRegion {
			continue
		}
		target.Evidence[index].Value = target.Region
		target.Evidence[index].Message = "region plan used for interpretation; candidate regions: " + strings.Join(regions, ", ")
		copied = true
		break
	}
	if !copied {
		target.Evidence = append(target.Evidence, Evidence{
			Kind: EvidenceRegion, Value: target.Region,
			Message: "region plan used for interpretation; candidate regions: " + strings.Join(regions, ", "),
		})
	}
}

func (s *snapshot) countryCodeMatches(digits []digitChar, start int) []countryCodeMatch {
	var matches []countryCodeMatch
	remaining := len(digits) - start
	if remaining <= 0 {
		return nil
	}
	max := 3
	if remaining < max {
		max = remaining
	}
	for length := 1; length <= max; length++ {
		code := digitsString(digits, start, length)
		regions, ok := s.byCC[code]
		if !ok {
			continue
		}
		matches = append(matches, countryCodeMatch{
			code: code, start: start, end: start + length,
			regions: append([]string(nil), regions...),
		})
	}
	sort.SliceStable(matches, func(a, b int) bool {
		if matches[a].end-matches[a].start != matches[b].end-matches[b].start {
			return matches[a].end-matches[a].start < matches[b].end-matches[b].start
		}
		return matches[a].code < matches[b].code
	})
	return matches
}

func sortCandidates(candidates []Interpretation) {
	sort.SliceStable(candidates, func(a, b int) bool {
		left, right := candidates[a], candidates[b]
		if possibilityRank(left.Possibility) != possibilityRank(right.Possibility) {
			return possibilityRank(left.Possibility) < possibilityRank(right.Possibility)
		}
		if kindRank(left.Kind) != kindRank(right.Kind) {
			return kindRank(left.Kind) < kindRank(right.Kind)
		}
		if validityRank(left.Validity) != validityRank(right.Validity) {
			return validityRank(left.Validity) < validityRank(right.Validity)
		}
		if left.CountryCode != right.CountryCode {
			return left.CountryCode < right.CountryCode
		}
		if len(left.TrunkPrefix) != len(right.TrunkPrefix) {
			return len(left.TrunkPrefix) > len(right.TrunkPrefix)
		}
		if left.TrunkPrefix != right.TrunkPrefix {
			return left.TrunkPrefix < right.TrunkPrefix
		}
		if left.NationalNumber != right.NationalNumber {
			return left.NationalNumber < right.NationalNumber
		}
		return left.Region < right.Region
	})
}

func validityRank(validity Validity) int {
	switch validity {
	case ValidityValid:
		return 0
	case ValidityUnknown:
		return 1
	case ValidityInvalid:
		return 2
	default:
		return 3
	}
}

func kindRank(kind InterpretationKind) int {
	switch kind {
	case KindInternationalPlus:
		return 0
	case KindInternationalIDD:
		return 1
	case KindNationalTrunk:
		return 2
	case KindNational:
		return 3
	case KindInternationalBare:
		return 4
	default:
		return 5
	}
}

func possibilityRank(possibility Possibility) int {
	switch possibility {
	case PossibilityPossible:
		return 0
	case PossibilityUnknown:
		return 1
	case PossibilityImpossible:
		return 2
	default:
		return 3
	}
}

func internationalPrefixMessage(kind InterpretationKind, assumed bool) string {
	message := ""
	switch kind {
	case KindInternationalPlus:
		message = "leading plus sign identifies an international number"
	case KindInternationalIDD:
		message = "international direct dialing prefix for the default region"
	case KindInternationalBare:
		message = "country code appears without an international marker"
	default:
		message = "international prefix"
	}
	if assumed {
		message += "; the default exit prefix was assumed for this region"
	}
	return message
}

func prefixText(input string, span Span) string {
	if span.Start < 0 || span.End < span.Start || span.End > len(input) {
		return ""
	}
	return input[span.Start:span.End]
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func uniqueSorted(values []string) []string {
	values = uniqueStrings(values)
	sort.Strings(values)
	return values
}

func joinInts(values []int) string {
	parts := make([]string, len(values))
	for index, value := range values {
		parts[index] = strconv.Itoa(value)
	}
	return strings.Join(parts, ", ")
}

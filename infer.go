package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"strings"
)

var (
	// ErrNoSamples is returned when inference is called without samples.
	ErrNoSamples = errors.New("csvdialect: no samples supplied")
	// ErrNoCandidate is returned when no delimiter/quote/encoding combination
	// can parse the supplied samples.
	ErrNoCandidate = errors.New("csvdialect: no viable dialect candidate")
	// ErrAmbiguous is returned by InferDialect when the evidence is not strong
	// enough to select one dialect. Infer still returns the full result.
	ErrAmbiguous = errors.New("csvdialect: evidence is insufficient; see the ambiguity set")
)

// ScoreComponents are the explainable, per-candidate scores in [0, 1].
type ScoreComponents struct {
	Encoding  float64 `json:"encoding"`
	Delimiter float64 `json:"delimiter"`
	Width     float64 `json:"width"`
	Quotes    float64 `json:"quotes"`
	Escape    float64 `json:"escape"`
	Newline   float64 `json:"newline"`
	Coverage  float64 `json:"coverage"`
}

// Evidence is the aggregate factual support for a candidate.
type Evidence struct {
	Files                int            `json:"files"`
	FilesParsed          int            `json:"files_parsed"`
	Records              int            `json:"records"`
	NonBlankRecords      int            `json:"non_blank_records"`
	BlankRecords         int            `json:"blank_records"`
	Fields               int            `json:"fields"`
	DelimiterOccurrences int            `json:"delimiter_occurrences"`
	RecordsWithDelimiter int            `json:"records_with_delimiter"`
	QuotedFields         int            `json:"quoted_fields"`
	EmbeddedDelimiters   int            `json:"embedded_delimiters"`
	EmbeddedNewlines     int            `json:"embedded_newlines"`
	DoubledQuoteEscapes  int            `json:"doubled_quote_escapes"`
	EscapeUses           int            `json:"escape_uses"`
	EscapeLikeSequences  int            `json:"escape_like_sequences"`
	EscapeErrors         int            `json:"escape_errors"`
	QuoteErrors          int            `json:"quote_errors"`
	BareQuotes           int            `json:"bare_quotes"`
	UnterminatedQuotes   int            `json:"unterminated_quotes"`
	TextAfterQuote       int            `json:"text_after_quote"`
	QuoteLikeFields      int            `json:"quote_like_fields"`
	DominantWidth        int            `json:"dominant_width"`
	WidthCounts          map[int]int    `json:"width_counts"`
	WidthConsistency     float64        `json:"width_consistency"`
	FileWidthConsistency float64        `json:"file_width_consistency"`
	FileWidths           map[string]int `json:"file_widths"`
	NewlineCounts        map[string]int `json:"newline_counts"`
	QuotedNewlineCounts  map[string]int `json:"quoted_newline_counts"`
	NewlineConsistency   float64        `json:"newline_consistency"`
	EncodingMatches      int            `json:"encoding_matches"`
	EncodingConsistency  float64        `json:"encoding_consistency"`
	Bytes                int            `json:"bytes"`
}

// FileEvidence is the parse evidence contributed by one sample.
type FileEvidence struct {
	Name                string         `json:"name"`
	Bytes               int            `json:"bytes"`
	Decoded             bool           `json:"decoded"`
	Encoding            Encoding       `json:"encoding"`
	BOM                 bool           `json:"bom"`
	Error               string         `json:"error,omitempty"`
	Records             int            `json:"records"`
	DominantWidth       int            `json:"dominant_width"`
	WidthConsistency    float64        `json:"width_consistency"`
	Delimiters          int            `json:"delimiters"`
	QuotedFields        int            `json:"quoted_fields"`
	QuoteErrors         int            `json:"quote_errors"`
	EscapeLikeSequences int            `json:"escape_like_sequences"`
	Newlines            map[string]int `json:"newlines"`
	ParseSignature      uint64         `json:"parse_signature"`
}

// Candidate is one dialect hypothesis with its score and evidence.
type Candidate struct {
	Dialect        Dialect         `json:"dialect"`
	Score          float64         `json:"score"`
	Components     ScoreComponents `json:"components"`
	Evidence       Evidence        `json:"evidence"`
	ValidQuotes    bool            `json:"valid_quotes"`
	QuotePriority  int             `json:"quote_priority"`
	Reasons        []string        `json:"reasons"`
	ParseSignature uint64          `json:"parse_signature"`
	Files          []FileEvidence  `json:"files,omitempty"`

	delimiterRank int
	quoteRank     int
	escapeRank    int
	newlineRank   int
	encodingRank  int
	equivKey      string
}

// Result is the complete ranking returned by Infer.
//
// When Ambiguous is true, Ambiguities contains the near-tied, operationally
// distinct candidates that the evidence cannot separate. Best is still the
// highest-ranked candidate so callers can inspect or explicitly override it.
type Result struct {
	Best Candidate `json:"best"`
	// Candidates is ordered by QuotePriority first, then by Score and
	// deterministic candidate priors.
	Candidates  []Candidate    `json:"candidates"`
	Ambiguous   bool           `json:"ambiguous"`
	Ambiguities []Candidate    `json:"ambiguities,omitempty"`
	Reasons     []string       `json:"reasons,omitempty"`
	Files       []FileEvidence `json:"files"`
	Warnings    []string       `json:"warnings,omitempty"`
}

// Dialect returns the best dialect, even when the result is ambiguous.
func (r *Result) Dialect() Dialect {
	if r == nil {
		return Dialect{}
	}
	return r.Best.Dialect
}

// Err reports ErrAmbiguous when the evidence is insufficient.
func (r *Result) Err() error {
	if r == nil {
		return ErrNoCandidate
	}
	if len(r.Candidates) == 0 && r.Best.Dialect.Delimiter == 0 {
		return ErrNoCandidate
	}
	if r.Ambiguous {
		return ErrAmbiguous
	}
	return nil
}

// Infer jointly infers one CSV dialect from all samples.
func Infer(samples []Sample, options ...Option) (*Result, error) {
	return InferWithOptions(samples, resolveOptions(options))
}

// InferWithOptions is the non-functional-option form of Infer.
func InferWithOptions(samples []Sample, opts Options) (*Result, error) {
	opts = opts.withDefaults()
	opts, err := opts.validate()
	if err != nil {
		return nil, err
	}
	if len(samples) == 0 {
		return nil, ErrNoSamples
	}

	prepared := prepareSamples(samples, opts.MaxSampleBytes)
	encodings := selectEncodings(prepared, opts)
	potentialQuotes := potentialQuotes(opts)

	var candidates []Candidate
	var warnings []string
	truncated := false
	for _, sample := range prepared {
		if sample.truncated {
			truncated = true
			break
		}
	}
	if truncated {
		warnings = append(warnings, fmt.Sprintf("samples were truncated to %d bytes for inference", opts.MaxSampleBytes))
	}

	for _, encoding := range encodings {
		decoded := decodeSamples(prepared, encoding)
		decodedCount := 0
		for _, sample := range decoded {
			if sample.err == nil {
				decodedCount++
			}
		}
		if decodedCount == 0 {
			continue
		}
		encScore, encConsistency, encMatches, bom := encodingComponent(decoded, encoding, prepared)

		for _, delimiter := range opts.Delimiters {
			for _, quote := range opts.Quotes {
				if quote == delimiter {
					continue
				}
				escapes := opts.Escapes
				if quote == 0 {
					escapes = make([]EscapeMode, 0, len(opts.Escapes))
					for _, mode := range opts.Escapes {
						if mode != EscapeDoubled {
							escapes = append(escapes, mode)
						}
					}
					if len(escapes) == 0 {
						escapes = []EscapeMode{EscapeNone}
					}
				}
				for _, escape := range escapes {
					base := Dialect{
						Delimiter: delimiter,
						Quote:     quote,
						Newline:   "\n",
						Encoding:  encoding,
						BOM:       bom,
					}
					switch escape {
					case EscapeDoubled:
						if quote == 0 {
							continue
						}
						base.DoubleQuote = true
					case EscapeBackslash:
						base.Escape = '\\'
					case EscapeNone:
					}
					if base.Escape != 0 && (base.Escape == delimiter || base.Escape == quote) {
						continue
					}

					agg := aggregateSamples(decoded, base, potentialQuotes)
					if agg.filesParsed == 0 {
						continue
					}
					quoteComponent, validQuotes := quoteComponent(base, agg)
					componentBase := ScoreComponents{
						Encoding:  encScore,
						Delimiter: delimiterComponent(agg),
						Width:     widthComponent(agg),
						Quotes:    quoteComponent,
						Escape:    escapeComponent(base, agg),
						Coverage:  coverageComponent(agg),
					}

					for _, newline := range opts.Newlines {
						dialect := base
						dialect.Newline = newline
						components := componentBase
						components.Newline = newlineComponent(newline, agg)
						score := weightedScore(components, opts.Weights)
						candidate := Candidate{
							Dialect:        dialect,
							Score:          score,
							Components:     components,
							Evidence:       aggregateEvidence(agg, encMatches, encConsistency),
							ValidQuotes:    validQuotes,
							ParseSignature: agg.signature,
							Files:          aggregateFiles(agg, encoding),
							delimiterRank:  indexRune(opts.Delimiters, delimiter),
							quoteRank:      indexRune(opts.Quotes, quote),
							escapeRank:     indexEscape(opts.Escapes, escape),
							newlineRank:    indexString(opts.Newlines, newline),
							encodingRank:   indexEncoding(encodings, encoding),
						}
						newlineEvidence := totalCounts(agg.newlineCounts)
						candidate.equivKey = equivalenceKey(candidate.ParseSignature, candidate.Dialect, newlineEvidence)
						candidate.QuotePriority = quotePriority(candidate)
						candidate.Reasons = explainCandidate(candidate, agg, encMatches, len(prepared))
						candidates = append(candidates, candidate)
					}
				}
			}
		}
	}

	if len(candidates) == 0 {
		return nil, ErrNoCandidate
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidateLess(candidates[i], candidates[j])
	})

	result := &Result{
		Best:       candidates[0],
		Candidates: candidates,
		Files:      cloneFileEvidence(candidates[0].Files),
		Warnings:   warnings,
	}
	result.Ambiguous, result.Ambiguities, result.Reasons = ambiguity(candidates, opts, prepared)
	return result, nil
}

// InferDialect returns only the best dialect. Ambiguous evidence returns the
// best candidate together with ErrAmbiguous.
func InferDialect(samples []Sample, options ...Option) (Dialect, error) {
	result, err := Infer(samples, options...)
	if err != nil {
		return Dialect{}, err
	}
	if result.Ambiguous {
		return result.Best.Dialect, ErrAmbiguous
	}
	return result.Best.Dialect, nil
}

// Parse decodes and parses a complete byte stream with a known dialect. It
// always recognises all three common newline styles; use Lock.Validate when
// strict newline conformance is required.
func Parse(data []byte, dialect Dialect) ([]Record, error) {
	dialect = dialect.withDefaults()
	if err := dialect.Validate(); err != nil {
		return nil, err
	}
	text, _, err := decodeAs(data, dialect.Encoding)
	if err != nil {
		return nil, err
	}
	stats := tokenize(text, dialect, tokenizeOptions{
		CollectRecords:  true,
		PotentialQuotes: defaultPotentialQuotes(dialect.Quote),
	})
	if stats.FirstError != nil {
		return stats.RecordsData, stats.FirstError
	}
	return stats.RecordsData, nil
}

// ParseSample is Parse for a named Sample.
func ParseSample(sample Sample, dialect Dialect) ([]Record, error) {
	return Parse(sample.Data, dialect)
}

type preparedSample struct {
	name          string
	data          []byte
	originalBytes int
	guess         encodingGuess
	truncated     bool
}

type decodedSample struct {
	prepared *preparedSample
	text     string
	bom      bool
	err      error
}

func prepareSamples(samples []Sample, maxBytes int) []preparedSample {
	prepared := make([]preparedSample, len(samples))
	seenNames := make(map[string]int, len(samples))
	for i, sample := range samples {
		name := strings.TrimSpace(sample.Name)
		if name == "" {
			name = fmt.Sprintf("sample-%d", i+1)
		}
		seenNames[name]++
		if seenNames[name] > 1 {
			name = fmt.Sprintf("%s#%d", name, seenNames[name])
		}
		fullGuess := detectEncoding(sample.Data)
		data, truncated := limitSample(sample.Data, maxBytes, fullGuess.Encoding)
		prepared[i] = preparedSample{
			name:          name,
			data:          data,
			originalBytes: len(sample.Data),
			guess:         detectEncoding(data),
			truncated:     truncated,
		}
	}
	return prepared
}

func limitSample(data []byte, maxBytes int, encoding Encoding) ([]byte, bool) {
	if maxBytes <= 0 || len(data) <= maxBytes {
		return data, false
	}
	cut := maxBytes
	if index := bytes.LastIndexByte(data[:cut], '\n'); index >= cut/2 {
		cut = index + 1
	}
	if (encoding == EncodingUTF16LE || encoding == EncodingUTF16BE) && cut%2 != 0 {
		cut--
	}
	if cut <= 0 {
		return nil, true
	}
	return data[:cut], true
}

func selectEncodings(samples []preparedSample, opts Options) []Encoding {
	if len(opts.Encodings) > 0 {
		return append([]Encoding(nil), opts.Encodings...)
	}
	seen := make(map[Encoding]bool)
	var encodings []Encoding
	for _, sample := range samples {
		if len(sample.data) == 0 {
			continue
		}
		if seen[sample.guess.Encoding] {
			continue
		}
		seen[sample.guess.Encoding] = true
		encodings = append(encodings, sample.guess.Encoding)
	}
	if len(encodings) == 0 {
		encodings = []Encoding{EncodingUTF8}
	}
	// Latin-1 is a useful diagnostic fallback when samples disagree or when a
	// UTF-16 guess is uncertain. Its encoding score is deliberately lower.
	needLatin1 := seen[EncodingLatin1]
	if !needLatin1 {
		for _, sample := range samples {
			if len(sample.data) > 0 && sample.guess.Encoding != EncodingUTF8 {
				needLatin1 = true
				break
			}
		}
	}
	if needLatin1 && !seen[EncodingLatin1] {
		encodings = append(encodings, EncodingLatin1)
	}
	return encodings
}

func decodeSamples(samples []preparedSample, encoding Encoding) []decodedSample {
	decoded := make([]decodedSample, len(samples))
	for i := range samples {
		text, bom, err := decodeAs(samples[i].data, encoding)
		decoded[i] = decodedSample{
			prepared: &samples[i],
			text:     text,
			bom:      bom,
			err:      err,
		}
	}
	return decoded
}

func encodingComponent(decoded []decodedSample, encoding Encoding, prepared []preparedSample) (score, consistency float64, matches int, bom bool) {
	if len(prepared) == 0 {
		return 0, 0, 0, false
	}
	matched := 0.0
	bomCount := 0
	decodedCount := 0
	considered := 0
	for i := range decoded {
		sample := decoded[i]
		if sample.err != nil {
			continue
		}
		decodedCount++
		if len(prepared[i].data) == 0 {
			continue
		}
		considered++
		guess := prepared[i].guess
		switch {
		case encoding == guess.Encoding:
			matched += guess.Confidence
			matches++
		case isASCII(prepared[i].data) && (encoding == EncodingUTF8 || encoding == EncodingLatin1):
			matched += 0.95
			matches++
		case encoding == EncodingLatin1:
			matched += 0.15
		default:
			matched += 0.05
		}
		if sample.bom {
			bomCount++
		}
	}
	if considered == 0 {
		return 0.75, 0, 0, false
	}
	consistency = matched / float64(considered)
	base := 1.0
	switch encoding {
	case EncodingUTF16LE, EncodingUTF16BE:
		base = 0.95
	case EncodingLatin1:
		base = 0.9
	}
	score = math.Max(0, math.Min(1, consistency*base))
	bom = decodedCount > 0 && bomCount*2 >= decodedCount
	return score, consistency, matches, bom
}

type aggregateStats struct {
	files                int
	filesParsed          int
	records              int
	nonBlankRecords      int
	blankRecords         int
	fields               int
	delimiterOccurrences int
	recordsWithDelimiter int
	quotedFields         int
	embeddedDelimiters   int
	embeddedNewlines     int
	doubledQuoteEscapes  int
	escapeUses           int
	escapeLikeSequences  int
	escapeErrors         int
	quoteErrors          int
	bareQuotes           int
	unterminatedQuotes   int
	textAfterQuote       int
	quoteLikeFields      int
	widthCounts          map[int]int
	fileWidths           map[string]int
	newlineCounts        map[string]int
	quotedNewlineCounts  map[string]int
	signature            uint64
	filesData            []FileEvidence
	fileConsistencySum   float64
	bytes                int
}

func aggregateSamples(decoded []decodedSample, dialect Dialect, quotes []rune) aggregateStats {
	agg := aggregateStats{
		files:               len(decoded),
		widthCounts:         make(map[int]int),
		fileWidths:          make(map[string]int),
		newlineCounts:       make(map[string]int),
		quotedNewlineCounts: make(map[string]int),
	}
	hasher := fnv.New64a()
	for i := range decoded {
		sample := decoded[i]
		evidence := FileEvidence{
			Name:     sample.prepared.name,
			Bytes:    sample.prepared.originalBytes,
			Encoding: dialect.Encoding,
		}
		if sample.err != nil {
			evidence.Error = sample.err.Error()
			agg.filesData = append(agg.filesData, evidence)
			var zero [8]byte
			_, _ = hasher.Write(zero[:])
			_, _ = hasher.Write([]byte(sample.prepared.name))
			_, _ = hasher.Write([]byte{0x1D})
			continue
		}
		stats := tokenize(sample.text, dialect, tokenizeOptions{PotentialQuotes: quotes})
		evidence.Decoded = true
		evidence.BOM = sample.bom
		evidence.Records = stats.NonBlankRecords
		evidence.Delimiters = stats.DelimiterOccurrences
		evidence.QuotedFields = stats.QuotedFields
		evidence.QuoteErrors = stats.QuoteErrors
		evidence.EscapeLikeSequences = stats.EscapeLikeSequences
		evidence.Newlines = copyCounts(stats.NewlineCounts)
		evidence.ParseSignature = stats.Signature
		width, count := dominantWidth(stats.WidthCounts)
		evidence.DominantWidth = width
		if stats.NonBlankRecords > 0 {
			evidence.WidthConsistency = float64(count) / float64(stats.NonBlankRecords)
			agg.fileConsistencySum += evidence.WidthConsistency
		}
		agg.filesData = append(agg.filesData, evidence)
		agg.filesParsed++
		agg.records += stats.Records
		agg.nonBlankRecords += stats.NonBlankRecords
		agg.blankRecords += stats.BlankRecords
		agg.fields += stats.Fields
		agg.delimiterOccurrences += stats.DelimiterOccurrences
		agg.recordsWithDelimiter += stats.RecordsWithDelimiter
		agg.quotedFields += stats.QuotedFields
		agg.embeddedDelimiters += stats.EmbeddedDelimiters
		agg.embeddedNewlines += stats.EmbeddedNewlines
		agg.doubledQuoteEscapes += stats.DoubledQuoteEscapes
		agg.escapeUses += stats.EscapeUses
		agg.escapeLikeSequences += stats.EscapeLikeSequences
		agg.escapeErrors += stats.EscapeErrors
		agg.quoteErrors += stats.QuoteErrors
		agg.bareQuotes += stats.BareQuotes
		agg.unterminatedQuotes += stats.UnterminatedQuotes
		agg.textAfterQuote += stats.TextAfterQuote
		agg.quoteLikeFields += stats.QuoteLikeFields
		agg.bytes += len(sample.text)
		for widthKey, count := range stats.WidthCounts {
			agg.widthCounts[widthKey] += count
		}
		if width > 0 {
			agg.fileWidths[sample.prepared.name] = width
		}
		for newline, count := range stats.NewlineCounts {
			agg.newlineCounts[newline] += count
		}
		for newline, count := range stats.QuotedNewlineCounts {
			agg.quotedNewlineCounts[newline] += count
		}
		var encoded [8]byte
		binary.LittleEndian.PutUint64(encoded[:], stats.Signature)
		_, _ = hasher.Write(encoded[:])
		_, _ = hasher.Write([]byte{0x1D})
	}
	if agg.filesParsed > 0 {
		agg.fileConsistencySum /= float64(agg.filesParsed)
	}
	agg.signature = hasher.Sum64()
	return agg
}

func aggregateEvidence(agg aggregateStats, encodingMatches int, encodingConsistency float64) Evidence {
	width, count := dominantWidth(agg.widthCounts)
	widthConsistency := 0.0
	if agg.nonBlankRecords > 0 {
		widthConsistency = float64(count) / float64(agg.nonBlankRecords)
	}
	evidence := Evidence{
		Files:                agg.files,
		FilesParsed:          agg.filesParsed,
		Records:              agg.records,
		NonBlankRecords:      agg.nonBlankRecords,
		BlankRecords:         agg.blankRecords,
		Fields:               agg.fields,
		DelimiterOccurrences: agg.delimiterOccurrences,
		RecordsWithDelimiter: agg.recordsWithDelimiter,
		QuotedFields:         agg.quotedFields,
		EmbeddedDelimiters:   agg.embeddedDelimiters,
		EmbeddedNewlines:     agg.embeddedNewlines,
		DoubledQuoteEscapes:  agg.doubledQuoteEscapes,
		EscapeUses:           agg.escapeUses,
		EscapeLikeSequences:  agg.escapeLikeSequences,
		EscapeErrors:         agg.escapeErrors,
		QuoteErrors:          agg.quoteErrors,
		BareQuotes:           agg.bareQuotes,
		UnterminatedQuotes:   agg.unterminatedQuotes,
		TextAfterQuote:       agg.textAfterQuote,
		QuoteLikeFields:      agg.quoteLikeFields,
		DominantWidth:        width,
		WidthCounts:          copyWidths(agg.widthCounts),
		WidthConsistency:     widthConsistency,
		FileWidthConsistency: agg.fileConsistencySum,
		FileWidths:           copyIntMap(agg.fileWidths),
		NewlineCounts:        copyCounts(agg.newlineCounts),
		QuotedNewlineCounts:  copyCounts(agg.quotedNewlineCounts),
		NewlineConsistency:   newlineConsistency(agg.newlineCounts),
		EncodingMatches:      encodingMatches,
		EncodingConsistency:  encodingConsistency,
		Bytes:                agg.bytes,
	}
	return evidence
}

func aggregateFiles(agg aggregateStats, encoding Encoding) []FileEvidence {
	files := make([]FileEvidence, len(agg.filesData))
	copy(files, agg.filesData)
	for i := range files {
		if files[i].Encoding == "" {
			files[i].Encoding = encoding
		}
		files[i].Newlines = copyCounts(files[i].Newlines)
	}
	return files
}

func cloneFileEvidence(files []FileEvidence) []FileEvidence {
	cloned := make([]FileEvidence, len(files))
	for i, file := range files {
		cloned[i] = file
		cloned[i].Newlines = copyCounts(file.Newlines)
	}
	return cloned
}

func delimiterComponent(agg aggregateStats) float64 {
	if agg.nonBlankRecords == 0 {
		return 0
	}
	coverage := float64(agg.recordsWithDelimiter) / float64(agg.nonBlankRecords)
	density := 1 - math.Exp(-float64(agg.delimiterOccurrences)/float64(agg.nonBlankRecords))
	return math.Max(0, math.Min(1, 0.8*coverage+0.2*density))
}

func widthComponent(agg aggregateStats) float64 {
	if agg.nonBlankRecords == 0 {
		return 0
	}
	width, count := dominantWidth(agg.widthCounts)
	global := float64(count) / float64(agg.nonBlankRecords)
	score := 0.6*global + 0.4*agg.fileConsistencySum
	if width <= 1 {
		score *= 0.6
	}
	return math.Max(0, math.Min(1, score))
}

func quoteComponent(dialect Dialect, agg aggregateStats) (float64, bool) {
	if dialect.Quote == 0 {
		if agg.quoteLikeFields == 0 {
			// No quote evidence: treat "quoting disabled" as valid, but give
			// the conventional quote candidates a slight prior advantage so
			// an ordinary unquoted sample locks the RFC-style quote character.
			return 0.75, true
		}
		// Any field that starts with a quote character is evidence that
		// quoting is active. Treating it as literal text is not allowed to
		// win merely because it produces a stable column count.
		return 0, false
	}
	if agg.unterminatedQuotes > 0 {
		return 0, false
	}
	errors := agg.bareQuotes + agg.textAfterQuote
	if agg.quotedFields == 0 {
		if errors == 0 {
			return 0.8, true
		}
		return 0, false
	}
	if errors == 0 {
		return 1, true
	}
	penalty := float64(errors) / float64(agg.quotedFields+errors)
	return math.Max(0, 1-penalty), false
}

func escapeComponent(dialect Dialect, agg aggregateStats) float64 {
	switch dialect.EscapeMode() {
	case EscapeBackslash:
		if agg.escapeErrors > 0 {
			return 0
		}
		if agg.escapeUses > 0 {
			return 1
		}
		return 0.62
	case EscapeDoubled:
		if agg.doubledQuoteEscapes > 0 {
			return 1
		}
		return 0.9
	case EscapeNone:
		if dialect.Quote == 0 {
			if agg.escapeLikeSequences == 0 {
				return 1
			}
			ratio := float64(agg.escapeLikeSequences) / math.Max(1, float64(agg.nonBlankRecords))
			return math.Max(0, 1-ratio)
		}
		if agg.escapeLikeSequences > 0 {
			ratio := float64(agg.escapeLikeSequences) / math.Max(1, float64(agg.nonBlankRecords))
			return math.Max(0, 0.8*(1-ratio))
		}
		return 0.8
	default:
		return 0
	}
}

func newlineComponent(newline string, agg aggregateStats) float64 {
	total := totalCounts(agg.newlineCounts)
	if total == 0 {
		if newline == "\n" {
			return 0.6
		}
		return 0.55
	}
	return float64(agg.newlineCounts[newline]) / float64(total)
}

func coverageComponent(agg aggregateStats) float64 {
	if agg.files == 0 {
		return 0
	}
	coverage := float64(agg.filesParsed) / float64(agg.files)
	if agg.nonBlankRecords == 0 {
		coverage *= 0.25
	}
	return coverage
}

func weightedScore(components ScoreComponents, weights Weights) float64 {
	score := components.Encoding*weights.Encoding +
		components.Delimiter*weights.Delimiter +
		components.Width*weights.Width +
		components.Quotes*weights.Quotes +
		components.Escape*weights.Escape +
		components.Newline*weights.Newline +
		components.Coverage*weights.Coverage
	return math.Max(0, math.Min(1, score))
}

func newlineConsistency(counts map[string]int) float64 {
	total := totalCounts(counts)
	if total == 0 {
		return 0
	}
	best := 0
	for _, count := range counts {
		if count > best {
			best = count
		}
	}
	return float64(best) / float64(total)
}

func dominantWidth(counts map[int]int) (int, int) {
	width, count := 0, 0
	for candidate, occurrences := range counts {
		if occurrences > count || (occurrences == count && candidate > width) {
			width, count = candidate, occurrences
		}
	}
	return width, count
}

func totalCounts(counts map[string]int) int {
	total := 0
	for _, count := range counts {
		total += count
	}
	return total
}

func copyCounts(counts map[string]int) map[string]int {
	copied := make(map[string]int, len(counts))
	for key, value := range counts {
		copied[key] = value
	}
	return copied
}

func copyIntMap(values map[string]int) map[string]int {
	copied := make(map[string]int, len(values))
	for key, value := range values {
		copied[key] = value
	}
	return copied
}

func candidateLess(a, b Candidate) bool {
	// Quote evidence is the primary tier. This is the explicit guard that
	// prevents a width-stable but quote-broken parse from outranking a parse
	// that preserves quote structure. Within a tier the weighted score decides.
	if aPriority, bPriority := quotePriority(a), quotePriority(b); aPriority != bPriority {
		return aPriority > bPriority
	}
	if math.Abs(a.Score-b.Score) > 1e-9 {
		return a.Score > b.Score
	}
	if a.delimiterRank != b.delimiterRank {
		return a.delimiterRank < b.delimiterRank
	}
	if a.quoteRank != b.quoteRank {
		return a.quoteRank < b.quoteRank
	}
	if a.escapeRank != b.escapeRank {
		return a.escapeRank < b.escapeRank
	}
	if a.newlineRank != b.newlineRank {
		return a.newlineRank < b.newlineRank
	}
	if a.encodingRank != b.encodingRank {
		return a.encodingRank < b.encodingRank
	}
	return a.Dialect.String() < b.Dialect.String()
}

func quotePriority(candidate Candidate) int {
	if candidate.Evidence.Files > 0 && candidate.Evidence.FilesParsed < candidate.Evidence.Files {
		// A candidate that cannot decode the whole sample set is not a valid
		// joint dialect, regardless of how well it parses the subset.
		return 0
	}
	switch {
	case candidate.Evidence.QuotedFields > 0 && candidate.Components.Quotes >= 0.5:
		// The candidate actually found and preserved quoted fields.
		return 3
	case candidate.ValidQuotes:
		// Structurally valid, but no quoted field was observed (unused quote
		// character or quoting disabled).
		return 2
	case candidate.Evidence.QuotedFields > 0:
		// Quote fields were found, but most quote events are malformed.
		return 1
	default:
		// Quote structure is being ignored or is badly broken.
		return 0
	}
}

func equivalenceKey(signature uint64, dialect Dialect, newlineEvidence int) string {
	key := fmt.Sprintf("%016x", signature)
	if newlineEvidence > 0 {
		key += "|nl=" + dialect.Newline
	}
	return key
}

func explainCandidate(candidate Candidate, agg aggregateStats, encodingMatches, files int) []string {
	var reasons []string
	reasons = append(reasons, fmt.Sprintf(
		"encoding %s matched %d/%d samples (BOM=%t)",
		candidate.Dialect.Encoding, encodingMatches, files, candidate.Dialect.BOM,
	))
	reasons = append(reasons, fmt.Sprintf(
		"delimiter %q occurs %d times outside quotes across %d/%d records",
		candidate.Dialect.Delimiter, agg.delimiterOccurrences,
		agg.recordsWithDelimiter, agg.nonBlankRecords,
	))
	if agg.nonBlankRecords > 0 {
		width, count := dominantWidth(agg.widthCounts)
		reasons = append(reasons, fmt.Sprintf(
			"width %d fields covers %d/%d records (%.1f%%), per-file consistency %.1f%%",
			width, count, agg.nonBlankRecords,
			100*float64(count)/float64(agg.nonBlankRecords), 100*agg.fileConsistencySum,
		))
	} else {
		reasons = append(reasons, "no non-blank records were parsed")
	}
	if candidate.Dialect.Quote == 0 {
		reasons = append(reasons, fmt.Sprintf(
			"quoting disabled; %d field(s) look quoted", agg.quoteLikeFields,
		))
	} else {
		reasons = append(reasons, fmt.Sprintf(
			"quote %q: %d quoted fields, %d embedded delimiter(s), %d embedded newline(s), %d quote error(s)",
			candidate.Dialect.Quote, agg.quotedFields, agg.embeddedDelimiters,
			agg.embeddedNewlines, agg.quoteErrors,
		))
	}
	reasons = append(reasons, fmt.Sprintf("quote evidence tier %d/3", candidate.QuotePriority))
	switch candidate.Dialect.EscapeMode() {
	case EscapeBackslash:
		reasons = append(reasons, fmt.Sprintf(
			"backslash escape used %d time(s), %d error(s)", agg.escapeUses, agg.escapeErrors,
		))
	case EscapeDoubled:
		reasons = append(reasons, fmt.Sprintf(
			"doubled-quote escape used %d time(s)", agg.doubledQuoteEscapes,
		))
	default:
		if agg.escapeLikeSequences > 0 {
			reasons = append(reasons, fmt.Sprintf(
				"no escape mechanism active; %d backslash-before-special sequence(s) suggest an escaped dialect",
				agg.escapeLikeSequences,
			))
		} else {
			reasons = append(reasons, "no quote escape mechanism")
		}
	}
	total := totalCounts(agg.newlineCounts)
	if total == 0 {
		reasons = append(reasons, "no record terminators observed; newline selected by prior")
	} else {
		reasons = append(reasons, fmt.Sprintf(
			"newline %s accounts for %d/%d record terminators (%.1f%%)",
			newlineLabel(candidate.Dialect.Newline), agg.newlineCounts[candidate.Dialect.Newline],
			total, 100*float64(agg.newlineCounts[candidate.Dialect.Newline])/float64(total),
		))
	}
	if candidate.Evidence.QuoteErrors > 0 {
		reasons = append(reasons, fmt.Sprintf(
			"quote structure is invalid: %d unterminated, %d bare, %d trailing text",
			agg.unterminatedQuotes, agg.bareQuotes, agg.textAfterQuote,
		))
	}
	if agg.filesParsed != agg.files {
		reasons = append(reasons, fmt.Sprintf(
			"only %d/%d samples decoded with this encoding", agg.filesParsed, agg.files,
		))
	}
	return reasons
}

func newlineLabel(newline string) string {
	switch newline {
	case "\r\n":
		return "CRLF"
	case "\r":
		return "CR"
	default:
		return "LF"
	}
}

func potentialQuotes(opts Options) []rune {
	quotes := make([]rune, 0, len(opts.Quotes))
	for _, quote := range opts.Quotes {
		if quote != 0 {
			quotes = append(quotes, quote)
		}
	}
	if len(quotes) == 0 {
		return []rune{'"', '\''}
	}
	return quotes
}

func defaultPotentialQuotes(extra rune) []rune {
	quotes := []rune{'"', '\''}
	if extra != 0 && extra != '"' && extra != '\'' {
		quotes = append(quotes, extra)
	}
	return quotes
}

func ambiguity(candidates []Candidate, opts Options, prepared []preparedSample) (bool, []Candidate, []string) {
	best := candidates[0]
	var reasons []string

	if best.Evidence.NonBlankRecords < opts.MinRecords {
		reasons = append(reasons, fmt.Sprintf(
			"only %d non-blank record(s); at least %d are required",
			best.Evidence.NonBlankRecords, opts.MinRecords,
		))
	}
	if best.Evidence.DelimiterOccurrences == 0 {
		reasons = append(reasons, "no delimiter was observed outside quotes; the filename/dialect is underdetermined")
	}
	if best.Score < opts.MinScore {
		reasons = append(reasons, fmt.Sprintf("best score %.3f is below the minimum %.3f", best.Score, opts.MinScore))
	}
	if best.Components.Encoding < 0.5 {
		reasons = append(reasons, fmt.Sprintf("encoding evidence is weak (%.3f)", best.Components.Encoding))
	}
	if best.Evidence.FilesParsed < len(prepared) {
		reasons = append(reasons, fmt.Sprintf(
			"only %d/%d samples decode with one encoding", best.Evidence.FilesParsed, len(prepared),
		))
	}
	if encodingGuessSet(prepared) > 1 {
		reasons = append(reasons, "samples disagree on character encoding")
	}
	if distinctWidths(best.Evidence.FileWidths) > 1 {
		reasons = append(reasons, "samples disagree on dominant column count")
	}
	if perFileNewlinesDisagree(candidates, prepared) {
		reasons = append(reasons, "samples disagree on the dominant newline style")
	}

	window := opts.AmbiguityMargin
	if len(reasons) > 0 {
		window = math.Max(window, 0.08)
	}
	seen := make(map[string]bool)
	ambiguities := make([]Candidate, 0, opts.MaxAmbiguities)
	for _, candidate := range candidates {
		if len(ambiguities) >= opts.MaxAmbiguities {
			break
		}
		if quotePriority(candidate) != quotePriority(best) {
			continue
		}
		if best.Score-candidate.Score > window {
			continue
		}
		key := candidate.equivKey
		if seen[key] && candidate.Dialect.Delimiter == best.Dialect.Delimiter {
			continue
		}
		seen[key] = true
		ambiguities = append(ambiguities, candidate)
	}

	// Insufficient evidence needs a useful set, not a single false winner.
	// Add the best candidate for each conflicting dimension (encoding, newline
	// or width), then distinct delimiter priors when the data is single-column.
	if len(reasons) > 0 {
		contains := func(candidate Candidate) bool {
			for _, existing := range ambiguities {
				if existing.Dialect == candidate.Dialect && existing.ParseSignature == candidate.ParseSignature {
					return true
				}
			}
			return false
		}
		add := func(candidate Candidate) {
			if len(ambiguities) >= opts.MaxAmbiguities {
				return
			}
			if candidate.ValidQuotes != best.ValidQuotes || contains(candidate) {
				return
			}
			ambiguities = append(ambiguities, candidate)
		}
		if encodingGuessSet(prepared) > 1 {
			seenEncoding := make(map[Encoding]bool)
			for _, candidate := range candidates {
				if seenEncoding[candidate.Dialect.Encoding] {
					continue
				}
				seenEncoding[candidate.Dialect.Encoding] = true
				add(candidate)
			}
		}
		if perFileNewlinesDisagree(candidates, prepared) {
			seenNewline := make(map[string]bool)
			for _, candidate := range candidates {
				if seenNewline[candidate.Dialect.Newline] {
					continue
				}
				seenNewline[candidate.Dialect.Newline] = true
				add(candidate)
			}
		}
		if distinctWidths(best.Evidence.FileWidths) > 1 {
			seenWidth := make(map[int]bool)
			for _, candidate := range candidates {
				if seenWidth[candidate.Evidence.DominantWidth] {
					continue
				}
				seenWidth[candidate.Evidence.DominantWidth] = true
				add(candidate)
			}
		}
		if len(ambiguities) < 2 {
			seenDelimiter := make(map[rune]bool)
			for _, candidate := range candidates {
				if seenDelimiter[candidate.Dialect.Delimiter] {
					continue
				}
				seenDelimiter[candidate.Dialect.Delimiter] = true
				add(candidate)
			}
		}
	}

	ambiguous := len(reasons) > 0
	if !ambiguous {
		distinct := 0
		for _, candidate := range ambiguities {
			if candidate.equivKey != best.equivKey || candidate.Dialect.Delimiter != best.Dialect.Delimiter {
				distinct++
			}
		}
		ambiguous = distinct > 0
	}
	if !ambiguous {
		return false, nil, nil
	}
	if len(ambiguities) == 0 {
		ambiguities = append(ambiguities, best)
	}
	return true, ambiguities, reasons
}

func encodingGuessSet(samples []preparedSample) int {
	seen := make(map[Encoding]bool)
	for _, sample := range samples {
		if len(sample.data) == 0 {
			continue
		}
		seen[sample.guess.Encoding] = true
	}
	return len(seen)
}

func distinctWidths(widths map[string]int) int {
	seen := make(map[int]bool)
	for _, width := range widths {
		if width > 0 {
			seen[width] = true
		}
	}
	return len(seen)
}

func perFileNewlinesDisagree(candidates []Candidate, prepared []preparedSample) bool {
	if len(prepared) < 2 {
		return false
	}
	styles := make(map[string]bool)
	for _, file := range candidates[0].Files {
		if !file.Decoded {
			continue
		}
		best, count := "", 0
		for _, newline := range []string{"\n", "\r\n", "\r"} {
			if occurrences := file.Newlines[newline]; occurrences > count {
				best, count = newline, occurrences
			}
		}
		if count > 0 {
			styles[best] = true
		}
	}
	return len(styles) > 1
}

func indexRune(values []rune, target rune) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return len(values)
}

func indexEscape(values []EscapeMode, target EscapeMode) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return len(values)
}

func indexString(values []string, target string) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return len(values)
}

func indexEncoding(values []Encoding, target Encoding) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return len(values)
}

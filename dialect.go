package dataeng

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// Encoding identifies the character encoding of a CSV byte stream.
type Encoding string

const (
	EncodingUTF8    Encoding = "utf-8"
	EncodingUTF16LE Encoding = "utf-16le"
	EncodingUTF16BE Encoding = "utf-16be"
	EncodingLatin1  Encoding = "iso-8859-1"
)

func (e Encoding) normalized() Encoding {
	switch strings.ToLower(strings.TrimSpace(string(e))) {
	case "utf-8", "utf8", "utf_8":
		return EncodingUTF8
	case "utf-16le", "utf16le", "utf-16-le":
		return EncodingUTF16LE
	case "utf-16be", "utf16be", "utf-16-be":
		return EncodingUTF16BE
	case "iso-8859-1", "iso8859-1", "latin1", "latin-1", "windows-1252", "cp1252":
		return EncodingLatin1
	default:
		return e
	}
}

// EscapeMode describes how a quote character is escaped inside a quoted field.
type EscapeMode string

const (
	// EscapeDoubled is the RFC 4180 style: a quote inside a quoted field is
	// written as two quote characters.
	EscapeDoubled EscapeMode = "doubled"
	// EscapeBackslash uses a backslash before a quote (and, in this package,
	// before a delimiter or newline).
	EscapeBackslash EscapeMode = "backslash"
	// EscapeNone declares that quotes cannot be escaped.
	EscapeNone EscapeMode = "none"
)

// Dialect is the complete CSV shape inferred for a set of samples.
//
// A zero Quote means that quoting is disabled. A zero Escape means that no
// backslash-style escape character is active; DoubleQuote separately controls
// RFC 4180 doubled-quote escaping.
type Dialect struct {
	Delimiter   rune     `json:"delimiter"`
	Quote       rune     `json:"quote"`
	Escape      rune     `json:"escape"`
	DoubleQuote bool     `json:"double_quote"`
	Newline     string   `json:"newline"`
	Encoding    Encoding `json:"encoding"`
	BOM         bool     `json:"bom"`
}

// EscapeMode reports the effective escape convention for d.
func (d Dialect) EscapeMode() EscapeMode {
	switch {
	case d.Escape != 0:
		return EscapeBackslash
	case d.Quote != 0 && d.DoubleQuote:
		return EscapeDoubled
	default:
		return EscapeNone
	}
}

// Validate checks that the dialect is structurally usable.
func (d Dialect) Validate() error {
	if d.Delimiter == 0 {
		return errors.New("csvdialect: delimiter must not be zero")
	}
	if d.Delimiter == '\r' || d.Delimiter == '\n' {
		return fmt.Errorf("csvdialect: delimiter %q is a line break", d.Delimiter)
	}
	if d.Quote == '\r' || d.Quote == '\n' {
		return fmt.Errorf("csvdialect: quote %q is a line break", d.Quote)
	}
	if d.Quote != 0 && d.Quote == d.Delimiter {
		return fmt.Errorf("csvdialect: quote and delimiter are both %q", d.Delimiter)
	}
	if d.Escape == '\r' || d.Escape == '\n' {
		return fmt.Errorf("csvdialect: escape %q is a line break", d.Escape)
	}
	if d.Escape != 0 && d.Escape == d.Delimiter {
		return fmt.Errorf("csvdialect: escape and delimiter are both %q", d.Delimiter)
	}
	if d.Escape != 0 && d.Quote != 0 && d.Escape == d.Quote {
		return fmt.Errorf("csvdialect: escape and quote are both %q", d.Quote)
	}
	switch d.Newline {
	case "", "\n", "\r\n", "\r":
	default:
		return fmt.Errorf("csvdialect: unsupported newline %q", d.Newline)
	}
	switch d.Encoding.normalized() {
	case "", EncodingUTF8, EncodingUTF16LE, EncodingUTF16BE, EncodingLatin1:
	default:
		return fmt.Errorf("csvdialect: unsupported encoding %q", d.Encoding)
	}
	return nil
}

func (d Dialect) withDefaults() Dialect {
	if d.Newline == "" {
		d.Newline = "\n"
	}
	if d.Encoding == "" {
		d.Encoding = EncodingUTF8
	}
	d.Encoding = d.Encoding.normalized()
	return d
}

func (d Dialect) String() string {
	return fmt.Sprintf(
		"delimiter=%q quote=%q escape=%q doubled=%t newline=%q encoding=%s bom=%t",
		d.Delimiter, d.Quote, d.Escape, d.DoubleQuote, d.Newline, d.Encoding, d.BOM,
	)
}

// Sample is one file (or one slice of a file) supplied to inference.
type Sample struct {
	Name string
	Data []byte
}

// Weights controls the contribution of each explainable score component.
// Weights are normalised so their sum is one.
type Weights struct {
	Encoding  float64 `json:"encoding"`
	Delimiter float64 `json:"delimiter"`
	Width     float64 `json:"width"`
	Quotes    float64 `json:"quotes"`
	Escape    float64 `json:"escape"`
	Newline   float64 `json:"newline"`
	Coverage  float64 `json:"coverage"`
}

// DefaultWeights are deliberately quote-heavy: a width-stable parse that
// ignores valid quote structure must not win over a structurally valid quoted
// parse. Width consistency still contributes, but quote validity is also a hard
// ranking gate in candidate ordering.
func DefaultWeights() Weights {
	return Weights{
		Encoding:  0.08,
		Delimiter: 0.18,
		Width:     0.18,
		Quotes:    0.32,
		Escape:    0.06,
		Newline:   0.12,
		Coverage:  0.06,
	}
}

func (w Weights) normalized() Weights {
	sum := w.Encoding + w.Delimiter + w.Width + w.Quotes + w.Escape + w.Newline + w.Coverage
	if sum <= 0 {
		return DefaultWeights()
	}
	return Weights{
		Encoding:  w.Encoding / sum,
		Delimiter: w.Delimiter / sum,
		Width:     w.Width / sum,
		Quotes:    w.Quotes / sum,
		Escape:    w.Escape / sum,
		Newline:   w.Newline / sum,
		Coverage:  w.Coverage / sum,
	}
}

// Options controls inference. InferWithOptions fills zero-value candidate
// slices and weights from DefaultOptions; use DefaultOptions when you want an
// explicit starting point.
type Options struct {
	Delimiters      []rune
	Quotes          []rune
	Escapes         []EscapeMode
	Newlines        []string
	Encodings       []Encoding
	Weights         Weights
	MinScore        float64
	AmbiguityMargin float64
	MaxAmbiguities  int
	MinRecords      int
	// MaxSampleBytes caps the prefix inspected per sample. Zero disables the
	// cap. A prefix is cut at a line boundary where possible.
	MaxSampleBytes int
}

func DefaultOptions() Options {
	return Options{
		Delimiters:      []rune{',', '\t', ';', '|', ':'},
		Quotes:          []rune{'"', '\'', 0},
		Escapes:         []EscapeMode{EscapeDoubled, EscapeNone, EscapeBackslash},
		Newlines:        []string{"\n", "\r\n", "\r"},
		Weights:         DefaultWeights(),
		MinScore:        0.55,
		AmbiguityMargin: 0.04,
		MaxAmbiguities:  8,
		MinRecords:      2,
		MaxSampleBytes:  8 << 20,
	}
}

// Option mutates an Options value.
type Option func(*Options)

func WithDelimiters(delimiters ...rune) Option {
	return func(o *Options) {
		o.Delimiters = append([]rune(nil), delimiters...)
	}
}

func WithQuotes(quotes ...rune) Option {
	return func(o *Options) {
		o.Quotes = append([]rune(nil), quotes...)
	}
}

func WithEscapes(escapes ...EscapeMode) Option {
	return func(o *Options) {
		o.Escapes = append([]EscapeMode(nil), escapes...)
	}
}

func WithNewlines(newlines ...string) Option {
	return func(o *Options) {
		o.Newlines = append([]string(nil), newlines...)
	}
}

func WithEncodings(encodings ...Encoding) Option {
	return func(o *Options) {
		o.Encodings = append([]Encoding(nil), encodings...)
	}
}

func WithWeights(weights Weights) Option {
	return func(o *Options) {
		o.Weights = weights
	}
}

func WithMinScore(score float64) Option {
	return func(o *Options) {
		o.MinScore = score
	}
}

func WithAmbiguityMargin(margin float64) Option {
	return func(o *Options) {
		o.AmbiguityMargin = margin
	}
}

func WithMaxAmbiguities(n int) Option {
	return func(o *Options) {
		o.MaxAmbiguities = n
	}
}

func WithMinRecords(n int) Option {
	return func(o *Options) {
		o.MinRecords = n
	}
}

func WithMaxSampleBytes(n int) Option {
	return func(o *Options) {
		o.MaxSampleBytes = n
	}
}

func resolveOptions(options []Option) Options {
	opts := DefaultOptions()
	for _, apply := range options {
		if apply != nil {
			apply(&opts)
		}
	}
	return opts
}

// withDefaults fills zero-value fields for callers that construct Options
// directly instead of starting from DefaultOptions. Scalar zero values that
// deliberately disable a feature (MinRecords, MaxSampleBytes) are preserved.
func (o Options) withDefaults() Options {
	defaults := DefaultOptions()
	if len(o.Delimiters) == 0 {
		o.Delimiters = defaults.Delimiters
	}
	if len(o.Quotes) == 0 {
		o.Quotes = defaults.Quotes
	}
	if len(o.Escapes) == 0 {
		o.Escapes = defaults.Escapes
	}
	if len(o.Newlines) == 0 {
		o.Newlines = defaults.Newlines
	}
	var sum float64
	for _, value := range []float64{
		o.Weights.Encoding, o.Weights.Delimiter, o.Weights.Width, o.Weights.Quotes,
		o.Weights.Escape, o.Weights.Newline, o.Weights.Coverage,
	} {
		sum += value
	}
	if sum <= 0 {
		o.Weights = defaults.Weights
	}
	if o.MinScore == 0 {
		o.MinScore = defaults.MinScore
	}
	if o.AmbiguityMargin == 0 {
		o.AmbiguityMargin = defaults.AmbiguityMargin
	}
	if o.MaxAmbiguities == 0 {
		o.MaxAmbiguities = defaults.MaxAmbiguities
	}
	return o
}

func (o Options) validate() (Options, error) {
	if len(o.Delimiters) == 0 {
		return o, errors.New("csvdialect: no delimiter candidates")
	}
	if len(o.Quotes) == 0 {
		o.Quotes = []rune{0}
	}
	if len(o.Escapes) == 0 {
		o.Escapes = []EscapeMode{EscapeNone}
	}
	if len(o.Newlines) == 0 {
		o.Newlines = []string{"\n"}
	}
	if math.IsNaN(o.AmbiguityMargin) || math.IsInf(o.AmbiguityMargin, 0) || o.AmbiguityMargin < 0 {
		return o, errors.New("csvdialect: ambiguity margin must not be negative")
	}
	if o.MaxAmbiguities <= 0 {
		o.MaxAmbiguities = 8
	}
	if o.MinRecords < 0 {
		return o, errors.New("csvdialect: minimum records must not be negative")
	}
	if o.MaxSampleBytes < 0 {
		return o, errors.New("csvdialect: maximum sample bytes must not be negative")
	}
	if math.IsNaN(o.MinScore) || math.IsInf(o.MinScore, 0) || o.MinScore < 0 || o.MinScore > 1 {
		return o, errors.New("csvdialect: minimum score must be between zero and one")
	}

	var sum float64
	for _, value := range []float64{
		o.Weights.Encoding, o.Weights.Delimiter, o.Weights.Width, o.Weights.Quotes,
		o.Weights.Escape, o.Weights.Newline, o.Weights.Coverage,
	} {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return o, errors.New("csvdialect: weights must not be negative")
		}
		sum += value
	}
	if sum <= 0 {
		return o, errors.New("csvdialect: weights must have a positive sum")
	}
	o.Weights = o.Weights.normalized()

	seenDelimiters := make(map[rune]bool, len(o.Delimiters))
	delimiters := make([]rune, 0, len(o.Delimiters))
	for _, delimiter := range o.Delimiters {
		if delimiter == 0 || delimiter == '\r' || delimiter == '\n' || seenDelimiters[delimiter] {
			continue
		}
		seenDelimiters[delimiter] = true
		delimiters = append(delimiters, delimiter)
	}
	if len(delimiters) == 0 {
		return o, errors.New("csvdialect: delimiter candidates contain no usable rune")
	}
	o.Delimiters = delimiters

	seenQuotes := make(map[rune]bool, len(o.Quotes))
	quotes := make([]rune, 0, len(o.Quotes)+1)
	hasNoQuote := false
	for _, quote := range o.Quotes {
		if quote == '\r' || quote == '\n' || seenQuotes[quote] {
			continue
		}
		if quote == 0 {
			hasNoQuote = true
		}
		seenQuotes[quote] = true
		quotes = append(quotes, quote)
	}
	if len(quotes) == 0 {
		quotes = []rune{0}
		hasNoQuote = true
	}
	if !hasNoQuote {
		quotes = append(quotes, 0)
	}
	o.Quotes = quotes

	seenEscapes := make(map[EscapeMode]bool, len(o.Escapes))
	escapes := make([]EscapeMode, 0, len(o.Escapes))
	for _, mode := range o.Escapes {
		if mode != EscapeDoubled && mode != EscapeBackslash && mode != EscapeNone {
			return o, fmt.Errorf("csvdialect: unsupported escape mode %q", mode)
		}
		if seenEscapes[mode] {
			continue
		}
		seenEscapes[mode] = true
		escapes = append(escapes, mode)
	}
	o.Escapes = escapes

	seenNewlines := make(map[string]bool, len(o.Newlines))
	newlines := make([]string, 0, len(o.Newlines))
	for _, newline := range o.Newlines {
		if newline != "\n" && newline != "\r\n" && newline != "\r" {
			return o, fmt.Errorf("csvdialect: unsupported newline %q", newline)
		}
		if seenNewlines[newline] {
			continue
		}
		seenNewlines[newline] = true
		newlines = append(newlines, newline)
	}
	o.Newlines = newlines

	seenEncodings := make(map[Encoding]bool, len(o.Encodings))
	encodings := make([]Encoding, 0, len(o.Encodings))
	for _, encoding := range o.Encodings {
		encoding = encoding.normalized()
		switch encoding {
		case EncodingUTF8, EncodingUTF16LE, EncodingUTF16BE, EncodingLatin1:
		default:
			return o, fmt.Errorf("csvdialect: unsupported encoding %q", encoding)
		}
		if seenEncodings[encoding] {
			continue
		}
		seenEncodings[encoding] = true
		encodings = append(encodings, encoding)
	}
	o.Encodings = encodings

	return o, nil
}

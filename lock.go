package dataeng

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

var (
	// ErrNotLocked is returned when ingestion is requested before a dialect is
	// locked.
	ErrNotLocked = errors.New("csvdialect: collector is not locked")
	// ErrAlreadyLocked is returned when inference or locking is requested after
	// the collector has locked its batch dialect.
	ErrAlreadyLocked = errors.New("csvdialect: collector is already locked")
)

// LockConfig controls strict conformance checks after a dialect is locked.
type LockConfig struct {
	Columns           int
	AllowAmbiguous    bool
	AllowBOMVariation bool
	AllowRagged       bool
	AllowEmpty        bool
	RequireNewline    bool
}

// LockOption mutates a LockConfig.
type LockOption func(*LockConfig)

func defaultLockConfig() LockConfig {
	return LockConfig{
		AllowBOMVariation: true,
		RequireNewline:    true,
	}
}

// WithColumns sets the expected field count. Zero leaves width checking to the
// inferred dominant width (when locking through Result.Lock) or disables it
// (when constructing with NewLock).
func WithColumns(columns int) LockOption {
	return func(config *LockConfig) {
		config.Columns = columns
	}
}

// AllowAmbiguousLock permits r.Lock to lock the best candidate even when
// inference returned an ambiguity set.
func AllowAmbiguousLock() LockOption {
	return func(config *LockConfig) {
		config.AllowAmbiguous = true
	}
}

func WithBOMVariation(allow bool) LockOption {
	return func(config *LockConfig) {
		config.AllowBOMVariation = allow
	}
}

func WithRaggedWidths(allow bool) LockOption {
	return func(config *LockConfig) {
		config.AllowRagged = allow
	}
}

func WithEmptyFiles(allow bool) LockOption {
	return func(config *LockConfig) {
		config.AllowEmpty = allow
	}
}

func WithStrictNewline(require bool) LockOption {
	return func(config *LockConfig) {
		config.RequireNewline = require
	}
}

// Lock is an immutable dialect snapshot. It never re-infers or mutates its
// dialect as new files arrive.
type Lock struct {
	dialect Dialect
	columns int
	config  LockConfig
}

// NewLock creates a lock for an explicitly supplied dialect.
func NewLock(dialect Dialect, options ...LockOption) (*Lock, error) {
	dialect = dialect.withDefaults()
	if err := dialect.Validate(); err != nil {
		return nil, err
	}
	config := defaultLockConfig()
	for _, apply := range options {
		if apply != nil {
			apply(&config)
		}
	}
	if config.Columns < 0 {
		return nil, errors.New("csvdialect: expected column count must not be negative")
	}
	return &Lock{dialect: dialect, columns: config.Columns, config: config}, nil
}

// LockDialect is an alias for NewLock.
func LockDialect(dialect Dialect, options ...LockOption) (*Lock, error) {
	return NewLock(dialect, options...)
}

// Lock snapshots the best inferred dialect. Unless AllowAmbiguousLock is used,
// an ambiguous result is refused rather than silently choosing a winner.
func (r *Result) Lock(options ...LockOption) (*Lock, error) {
	if r == nil || len(r.Candidates) == 0 {
		return nil, ErrNoCandidate
	}
	config := defaultLockConfig()
	for _, apply := range options {
		if apply != nil {
			apply(&config)
		}
	}
	if r.Ambiguous && !config.AllowAmbiguous {
		return nil, ErrAmbiguous
	}
	if config.Columns == 0 {
		config.Columns = r.Best.Evidence.DominantWidth
	}
	config.AllowAmbiguous = true
	return NewLock(r.Best.Dialect, func(target *LockConfig) {
		*target = config
	})
}

func (l *Lock) Dialect() Dialect {
	if l == nil {
		return Dialect{}
	}
	return l.dialect
}

// Columns returns the expected field count, or zero when width is not enforced.
func (l *Lock) Columns() int {
	if l == nil {
		return 0
	}
	return l.columns
}

// FileStatus is the disposition of one ingested file.
type FileStatus string

const (
	StatusAccepted    FileStatus = "accepted"
	StatusQuarantined FileStatus = "quarantined"
)

// ViolationKind identifies the conformance rule that failed.
type ViolationKind string

const (
	ViolationEncoding  ViolationKind = "encoding"
	ViolationDelimiter ViolationKind = "delimiter"
	ViolationQuote     ViolationKind = "quote"
	ViolationEscape    ViolationKind = "escape"
	ViolationNewline   ViolationKind = "newline"
	ViolationWidth     ViolationKind = "width"
	ViolationEmpty     ViolationKind = "empty"
)

// Violation describes one locked-dialect conformance failure.
type Violation struct {
	Kind    ViolationKind `json:"kind"`
	Message string        `json:"message"`
	Line    int           `json:"line,omitempty"`
}

func (v Violation) Error() string {
	if v.Line > 0 {
		return fmt.Sprintf("%s at line %d: %s", v.Kind, v.Line, v.Message)
	}
	return fmt.Sprintf("%s: %s", v.Kind, v.Message)
}

// FileStats summarises what the locked parser observed in a file.
type FileStats struct {
	Bytes           int            `json:"bytes"`
	Encoding        Encoding       `json:"encoding"`
	BOM             bool           `json:"bom"`
	Records         int            `json:"records"`
	NonBlankRecords int            `json:"non_blank_records"`
	BlankRecords    int            `json:"blank_records"`
	Fields          int            `json:"fields"`
	Widths          map[int]int    `json:"widths"`
	DominantWidth   int            `json:"dominant_width"`
	Delimiters      int            `json:"delimiters"`
	QuotedFields    int            `json:"quoted_fields"`
	QuoteErrors     int            `json:"quote_errors"`
	EscapeErrors    int            `json:"escape_errors"`
	Newlines        map[string]int `json:"newlines"`
}

// FileVerdict is the result of checking one file against a lock. Rejected
// files are quarantined; callers should route them separately and must not use
// them to revise the batch dialect.
type FileVerdict struct {
	File       string      `json:"file"`
	Status     FileStatus  `json:"status"`
	Accepted   bool        `json:"accepted"`
	Violations []Violation `json:"violations,omitempty"`
	Stats      FileStats   `json:"stats"`
}

func (v FileVerdict) IsQuarantined() bool {
	return v.Status == StatusQuarantined
}

// Validate checks one file against the locked dialect without changing the
// lock. Any deviation quarantines the file.
func (l *Lock) Validate(name string, data []byte) FileVerdict {
	verdict := FileVerdict{
		File:   name,
		Status: StatusAccepted,
		Stats:  FileStats{Bytes: len(data), Widths: map[int]int{}, Newlines: map[string]int{}},
	}
	if l == nil {
		verdict.Status = StatusQuarantined
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationEncoding,
			Message: "no dialect lock is available",
		})
		return verdict
	}

	guess := detectEncoding(data)
	text, bom, err := decodeAs(data, l.dialect.Encoding)
	verdict.Stats.Encoding = guess.Encoding
	verdict.Stats.BOM = bom
	if err != nil {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationEncoding,
			Message: fmt.Sprintf("cannot decode as %s: %v (detected %s)", l.dialect.Encoding, err, guess.Encoding),
		})
		return quarantined(verdict)
	}
	if len(data) > 0 && !encodingCompatible(l.dialect.Encoding, guess.Encoding, data) {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationEncoding,
			Message: fmt.Sprintf("input encoding is %s, locked to %s", guess.Encoding, l.dialect.Encoding),
		})
	}
	if len(data) > 0 && !l.config.AllowBOMVariation && bom != l.dialect.BOM {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationEncoding,
			Message: fmt.Sprintf("BOM presence is %t, locked to %t", bom, l.dialect.BOM),
		})
	}

	stats := tokenize(text, l.dialect, tokenizeOptions{
		ExpectedWidth:   l.columns,
		PotentialQuotes: defaultPotentialQuotes(l.dialect.Quote),
	})
	verdict.Stats.Records = stats.Records
	verdict.Stats.NonBlankRecords = stats.NonBlankRecords
	verdict.Stats.BlankRecords = stats.BlankRecords
	verdict.Stats.Fields = stats.Fields
	verdict.Stats.Widths = copyWidths(stats.WidthCounts)
	verdict.Stats.DominantWidth, _ = dominantWidth(stats.WidthCounts)
	verdict.Stats.Delimiters = stats.DelimiterOccurrences
	verdict.Stats.QuotedFields = stats.QuotedFields
	verdict.Stats.QuoteErrors = stats.QuoteErrors
	verdict.Stats.EscapeErrors = stats.EscapeErrors
	verdict.Stats.Newlines = copyCounts(stats.NewlineCounts)

	if stats.NonBlankRecords == 0 && !l.config.AllowEmpty {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationEmpty,
			Message: "file contains no non-blank records",
		})
	}

	if stats.UnterminatedQuotes > 0 {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationQuote,
			Message: fmt.Sprintf("%d quoted field(s) are not terminated", stats.UnterminatedQuotes),
			Line:    firstErrorLine(stats, parseErrorUnterminatedQuote),
		})
	}
	if stats.BareQuotes > 0 {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationQuote,
			Message: fmt.Sprintf("%d bare quote character(s) inside unquoted fields", stats.BareQuotes),
			Line:    firstErrorLine(stats, parseErrorBareQuote),
		})
	}
	if stats.TextAfterQuote > 0 {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationQuote,
			Message: fmt.Sprintf("%d field(s) contain text after a closing quote", stats.TextAfterQuote),
			Line:    firstErrorLine(stats, parseErrorTextAfterQuote),
		})
	}
	if l.dialect.Quote == 0 && stats.QuoteLikeFields > 0 {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationQuote,
			Message: fmt.Sprintf("lock disables quoting but %d field(s) look quoted", stats.QuoteLikeFields),
		})
	}
	if l.dialect.Quote != 0 && stats.QuoteLikeFields > 0 {
		for _, quote := range defaultPotentialQuotes(l.dialect.Quote) {
			if quote == l.dialect.Quote || quote == l.dialect.Delimiter ||
				quote == l.dialect.Escape || !strings.ContainsRune(text, quote) {
				continue
			}
			probe := l.dialect
			probe.Quote = quote
			probeStats := tokenize(text, probe, tokenizeOptions{
				ExpectedWidth:   l.columns,
				PotentialQuotes: []rune{l.dialect.Quote},
			})
			if probeStats.QuotedFields > 0 && probeStats.QuoteErrors == 0 &&
				(l.columns == 0 || probeStats.WidthMismatchCount == 0) {
				verdict.Violations = append(verdict.Violations, Violation{
					Kind: ViolationQuote,
					Message: fmt.Sprintf(
						"file appears to use quote %q, locked to %q", quote, l.dialect.Quote,
					),
				})
				break
			}
		}
	}
	if stats.EscapeErrors > 0 {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationEscape,
			Message: fmt.Sprintf("%d field(s) end with an escape character", stats.EscapeErrors),
			Line:    firstErrorLine(stats, parseErrorTrailingEscape),
		})
	}
	if l.dialect.EscapeMode() != EscapeBackslash && stats.EscapeLikeSequences > 0 {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind: ViolationEscape,
			Message: fmt.Sprintf(
				"%d backslash-before-special sequence(s) found, but locked escape mode is %s",
				stats.EscapeLikeSequences, l.dialect.EscapeMode(),
			),
		})
	}

	if l.columns > 1 && stats.NonBlankRecords > 0 && stats.DelimiterOccurrences == 0 {
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationDelimiter,
			Message: fmt.Sprintf("delimiter %q never occurs outside quotes", l.dialect.Delimiter),
		})
	}
	if l.columns > 0 {
		if l.config.AllowRagged {
			width, _ := dominantWidth(stats.WidthCounts)
			if stats.NonBlankRecords > 0 && width != l.columns {
				verdict.Violations = append(verdict.Violations, Violation{
					Kind:    ViolationWidth,
					Message: fmt.Sprintf("dominant width is %d fields, locked to %d", width, l.columns),
				})
			}
		} else if stats.WidthMismatchCount > 0 {
			verdict.Violations = append(verdict.Violations, Violation{
				Kind: ViolationWidth,
				Message: fmt.Sprintf(
					"%d record(s) have a width other than the locked %d fields; first mismatch is %d fields",
					stats.WidthMismatchCount, l.columns, stats.FirstMismatchWidth,
				),
				Line: stats.FirstMismatchLine,
			})
		}
	}

	if l.config.RequireNewline {
		mismatch := 0
		mismatchLine := 0
		firstMismatch := ""
		for newline, count := range stats.NewlineCounts {
			if newline == l.dialect.Newline {
				continue
			}
			mismatch += count
			if mismatchLine == 0 || stats.NewlineFirstLine[newline] < mismatchLine {
				mismatchLine = stats.NewlineFirstLine[newline]
				firstMismatch = newline
			}
		}
		if mismatch > 0 {
			verdict.Violations = append(verdict.Violations, Violation{
				Kind: ViolationNewline,
				Message: fmt.Sprintf(
					"%d record terminator(s) use %s, locked to %s",
					mismatch, newlineLabel(firstMismatch), newlineLabel(l.dialect.Newline),
				),
				Line: mismatchLine,
			})
		}
	}

	if len(verdict.Violations) > 0 {
		return quarantined(verdict)
	}
	verdict.Accepted = true
	return verdict
}

// ValidateSample is Validate for a named Sample.
func (l *Lock) ValidateSample(sample Sample) FileVerdict {
	return l.Validate(sample.Name, sample.Data)
}

// Parse validates and parses a file with the locked dialect. Quarantined files
// return their verdict and no records.
func (l *Lock) Parse(name string, data []byte) ([]Record, FileVerdict) {
	verdict := l.Validate(name, data)
	if !verdict.Accepted {
		return nil, verdict
	}
	records, err := Parse(data, l.dialect)
	if err != nil {
		verdict.Accepted = false
		verdict.Status = StatusQuarantined
		verdict.Violations = append(verdict.Violations, Violation{
			Kind:    ViolationQuote,
			Message: err.Error(),
		})
		return nil, verdict
	}
	return records, verdict
}

func quarantined(verdict FileVerdict) FileVerdict {
	verdict.Status = StatusQuarantined
	verdict.Accepted = false
	return verdict
}

func firstErrorLine(stats parseStats, kind string) int {
	if stats.FirstError != nil && stats.FirstError.Kind == kind {
		return stats.FirstError.Line
	}
	return 0
}

func copyWidths(widths map[int]int) map[int]int {
	copied := make(map[int]int, len(widths))
	for width, count := range widths {
		copied[width] = count
	}
	return copied
}

func encodingCompatible(locked, actual Encoding, data []byte) bool {
	if locked == actual {
		return true
	}
	if isASCII(data) && (locked == EncodingUTF8 || locked == EncodingLatin1) {
		return true
	}
	return false
}

// Batch ingests files under one immutable lock. It records accepted and
// quarantined files separately and never changes the lock in response to a
// violation.
type Batch struct {
	mu          sync.Mutex
	lock        *Lock
	accepted    []FileVerdict
	quarantined []FileVerdict
}

func NewBatch(lock *Lock) (*Batch, error) {
	if lock == nil {
		return nil, errors.New("csvdialect: nil lock")
	}
	return &Batch{lock: lock}, nil
}

func (b *Batch) Ingest(name string, data []byte) FileVerdict {
	if b == nil || b.lock == nil {
		return FileVerdict{
			File:   name,
			Status: StatusQuarantined,
			Violations: []Violation{{
				Kind:    ViolationEncoding,
				Message: "batch has no dialect lock",
			}},
		}
	}
	verdict := b.lock.Validate(name, data)
	b.mu.Lock()
	if verdict.Accepted {
		b.accepted = append(b.accepted, cloneVerdict(verdict))
	} else {
		b.quarantined = append(b.quarantined, cloneVerdict(verdict))
	}
	b.mu.Unlock()
	return verdict
}

func (b *Batch) IngestSample(sample Sample) FileVerdict {
	return b.Ingest(sample.Name, sample.Data)
}

func (b *Batch) IngestAll(samples []Sample) []FileVerdict {
	verdicts := make([]FileVerdict, len(samples))
	for i, sample := range samples {
		verdicts[i] = b.IngestSample(sample)
	}
	return verdicts
}

func (b *Batch) AcceptedFiles() []FileVerdict {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return cloneVerdicts(b.accepted)
}

func (b *Batch) QuarantinedFiles() []FileVerdict {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return cloneVerdicts(b.quarantined)
}

func (b *Batch) Dialect() Dialect {
	if b == nil || b.lock == nil {
		return Dialect{}
	}
	return b.lock.Dialect()
}

func (b *Batch) Columns() int {
	if b == nil || b.lock == nil {
		return 0
	}
	return b.lock.Columns()
}

// Collector is the file-collection entry point. Before Lock it accumulates
// samples for joint inference; after Lock it validates and quarantines new
// files without re-inferring the batch dialect.
type Collector struct {
	mu      sync.Mutex
	opts    Options
	samples []Sample
	lock    *Lock
	batch   *Batch
}

func NewCollector(options ...Option) *Collector {
	return &Collector{opts: resolveOptions(options)}
}

// Add accumulates a sample before locking, or ingests it after locking. The
// data is copied so later caller mutation cannot change inference evidence.
func (c *Collector) Add(sample Sample) error {
	data := append([]byte(nil), sample.Data...)
	sample.Data = data

	c.mu.Lock()
	if c.lock != nil {
		batch := c.batch
		c.mu.Unlock()
		batch.IngestSample(sample)
		return nil
	}
	c.samples = append(c.samples, sample)
	c.mu.Unlock()
	return nil
}

func (c *Collector) AddFile(name string, data []byte) error {
	return c.Add(Sample{Name: name, Data: data})
}

// Samples returns a copy of the accumulated samples.
func (c *Collector) Samples() []Sample {
	c.mu.Lock()
	defer c.mu.Unlock()
	samples := make([]Sample, len(c.samples))
	for i, sample := range c.samples {
		samples[i] = Sample{
			Name: sample.Name,
			Data: append([]byte(nil), sample.Data...),
		}
	}
	return samples
}

// Infer runs joint inference over the accumulated samples. It refuses to run
// after a lock so an already-published batch rule cannot drift.
func (c *Collector) Infer() (*Result, error) {
	c.mu.Lock()
	if c.lock != nil {
		c.mu.Unlock()
		return nil, ErrAlreadyLocked
	}
	samples := make([]Sample, len(c.samples))
	for i, sample := range c.samples {
		samples[i] = Sample{
			Name: sample.Name,
			Data: append([]byte(nil), sample.Data...),
		}
	}
	opts := c.opts
	c.mu.Unlock()
	return InferWithOptions(samples, opts)
}

// Lock infers and publishes an immutable dialect. Once locked, Add/Ingest can
// only accept or quarantine; they cannot revise the batch rule.
func (c *Collector) Lock(options ...LockOption) (*Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lock != nil {
		return nil, ErrAlreadyLocked
	}
	samples := make([]Sample, len(c.samples))
	for i, sample := range c.samples {
		samples[i] = Sample{
			Name: sample.Name,
			Data: append([]byte(nil), sample.Data...),
		}
	}
	opts := c.opts

	result, err := InferWithOptions(samples, opts)
	if err != nil {
		return nil, err
	}
	lock, err := result.Lock(options...)
	if err != nil {
		return result, err
	}
	batch, err := NewBatch(lock)
	if err != nil {
		return result, err
	}
	c.lock = lock
	c.batch = batch
	for _, sample := range samples {
		batch.IngestSample(sample)
	}
	return result, nil
}

// Ingest validates one file against the published lock and records it in the
// accepted or quarantine partition.
func (c *Collector) Ingest(sample Sample) (FileVerdict, error) {
	c.mu.Lock()
	batch := c.batch
	c.mu.Unlock()
	if batch == nil {
		return FileVerdict{}, ErrNotLocked
	}
	return batch.IngestSample(sample), nil
}

func (c *Collector) IngestFile(name string, data []byte) (FileVerdict, error) {
	return c.Ingest(Sample{Name: name, Data: data})
}

func (c *Collector) Locked() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lock != nil
}

func (c *Collector) Dialect() (Dialect, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lock == nil {
		return Dialect{}, false
	}
	return c.lock.Dialect(), true
}

func (c *Collector) Batch() *Batch {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.batch
}

func cloneVerdict(verdict FileVerdict) FileVerdict {
	cloned := verdict
	cloned.Violations = append([]Violation(nil), verdict.Violations...)
	cloned.Stats.Widths = copyWidths(verdict.Stats.Widths)
	cloned.Stats.Newlines = copyCounts(verdict.Stats.Newlines)
	return cloned
}

func cloneVerdicts(verdicts []FileVerdict) []FileVerdict {
	cloned := make([]FileVerdict, len(verdicts))
	for i, verdict := range verdicts {
		cloned[i] = cloneVerdict(verdict)
	}
	return cloned
}

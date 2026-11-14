package dataeng

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Config controls reassembly and truncation.
//
// A zero or negative MaxBytes or MaxFragments disables that individual limit.
// An empty TruncationMarker selects TruncationMarker.
type Config struct {
	MaxBytes         int
	MaxFragments     int
	TruncationMarker string
	// MaxSize, MaxLength, and Limit are aliases for the limits above.
	MaxSize            int
	MaxLength          int
	Limit              int
	MaxParts           int
	MaxRecordBytes     int
	MaxRecordFragments int
	TruncatedMarker    string
	// Marker is an alias for TruncationMarker.
	Marker string
	// Generation is the initial file generation.
	Generation any
}

// Option customizes a Reassembler.
type Option func(*Reassembler)

// Options is an alias for Config, for callers that prefer an options struct
// over functional options.
type Options = Config

// ReassemblerOptions is an alias for Config.
type ReassemblerOptions = Config

// WithMaxBytes limits the number of content bytes retained for one record.
// A non-positive value disables the byte limit.
func WithMaxBytes(n int) Option {
	return func(r *Reassembler) { r.MaxBytes = n }
}

// WithMaxSize is an alias for WithMaxBytes.
func WithMaxSize(n int) Option { return WithMaxBytes(n) }

// WithMaxLength is an alias for WithMaxBytes.
func WithMaxLength(n int) Option { return WithMaxBytes(n) }

// WithMaxFragments limits the number of fragments in one record.
// A non-positive value disables the fragment-count limit.
func WithMaxFragments(n int) Option {
	return func(r *Reassembler) { r.MaxFragments = n }
}

// WithFragmentLimit is an alias for WithMaxFragments.
func WithFragmentLimit(n int) Option { return WithMaxFragments(n) }

// WithMaxParts is an alias for WithMaxFragments.
func WithMaxParts(n int) Option { return WithMaxFragments(n) }

// WithLimit is an alias for WithMaxFragments.
func WithLimit(n int) Option { return WithMaxFragments(n) }

// WithTruncationMarker replaces the text appended to truncated content.
func WithTruncationMarker(marker string) Option {
	return func(r *Reassembler) { r.TruncationMarker = marker }
}

// WithMarker is an alias for WithTruncationMarker.
func WithMarker(marker string) Option { return WithTruncationMarker(marker) }

// WithTruncatedMarker is an alias for WithTruncationMarker.
func WithTruncatedMarker(marker string) Option { return WithTruncationMarker(marker) }

// WithMaxRecordBytes is an alias for WithMaxBytes.
func WithMaxRecordBytes(n int) Option { return WithMaxBytes(n) }

// WithMaxRecordFragments is an alias for WithMaxFragments.
func WithMaxRecordFragments(n int) Option { return WithMaxFragments(n) }

// WithGeneration sets the initial file generation.
func WithGeneration(generation any) Option {
	return func(r *Reassembler) {
		r.currentGeneration = generation
		r.currentGenerationKey = generationKey(generation)
		r.generationSet = true
	}
}

// MaxBytes is a shorthand for WithMaxBytes.
func MaxBytes(n int) Option { return WithMaxBytes(n) }

// MaxSize is a shorthand for WithMaxSize.
func MaxSize(n int) Option { return WithMaxSize(n) }

// MaxLength is a shorthand for WithMaxLength.
func MaxLength(n int) Option { return WithMaxLength(n) }

// MaxFragments is a shorthand for WithMaxFragments.
func MaxFragments(n int) Option { return WithMaxFragments(n) }

// MaxParts is a shorthand for WithMaxParts.
func MaxParts(n int) Option { return WithMaxParts(n) }

// Limit is a shorthand for WithLimit.
func Limit(n int) Option { return WithLimit(n) }

// Marker is a shorthand for WithTruncationMarker.
func Marker(marker string) Option { return WithTruncationMarker(marker) }

// Generation is a shorthand for WithGeneration.
func Generation(generation any) Option { return WithGeneration(generation) }

// Reassembler joins CRI P/F fragments into complete records.
//
// It is safe for concurrent use. The zero value is ready to use and has no
// size or fragment-count limit. Configure limits with the exported fields,
// NewReassembler, or the With... options.
type Reassembler struct {
	// MaxBytes is the maximum number of content bytes retained for a record.
	MaxBytes int
	// MaxFragments is the maximum number of fragments in a record.
	MaxFragments int
	// TruncationMarker is appended to content when a record is truncated.
	TruncationMarker string
	// Marker is an alias for TruncationMarker.
	Marker string

	// MaxSize, MaxLength, and Limit are accepted as aliases for the two
	// limits above, which makes the type convenient for literal
	// configuration. MaxSize/MaxLength map to MaxBytes; Limit maps to
	// MaxFragments.
	MaxSize            int
	MaxLength          int
	Limit              int
	MaxParts           int
	MaxRecordBytes     int
	MaxRecordFragments int
	TruncatedMarker    string

	mu      sync.Mutex
	nextSeq uint64
	pending map[recordKey]*pendingRecord
	closed  bool

	currentGeneration    any
	currentGenerationKey string
	generationSet        bool
}

type recordKey struct {
	stream     string
	source     string
	timestamp  string
	generation string
}

type pendingRecord struct {
	key   recordKey
	first Record
	seq   uint64

	content      strings.Builder
	contentBytes int
	fragments    int
	// emitted means the truncated result was already returned. Remaining
	// fragments are consumed until the final fragment or rotation; they must
	// not create a second output record.
	emitted bool
}

// NewReassembler creates a Reassembler.
//
// Arguments may be Options, Config values, a marker string, or integers.
// The first integer sets MaxFragments (the fragment count limit) and a
// second integer sets MaxBytes. This ordering mirrors the two conditions in
// the package contract: too many fragments, or too much content.
func NewReassembler(args ...any) *Reassembler {
	r := &Reassembler{}
	r.configure(args...)
	return r
}

// New is an alias for NewReassembler.
func New(args ...any) *Reassembler { return NewReassembler(args...) }

// NewAssembler is an alias for NewReassembler.
func NewAssembler(args ...any) *Reassembler { return NewReassembler(args...) }

// NewMerger is an alias for NewReassembler.
func NewMerger(args ...any) *Reassembler { return NewReassembler(args...) }

// NewCombiner is an alias for NewReassembler.
func NewCombiner(args ...any) *Reassembler { return NewReassembler(args...) }

// NewPartialReassembler is an alias for NewReassembler.
func NewPartialReassembler(args ...any) *Reassembler { return NewReassembler(args...) }

// NewCRIReassembler is an alias for NewReassembler.
func NewCRIReassembler(args ...any) *Reassembler { return NewReassembler(args...) }

// NewLogReassembler is an alias for NewReassembler.
func NewLogReassembler(args ...any) *Reassembler { return NewReassembler(args...) }

// Configure applies the same arguments accepted by NewReassembler.
func (r *Reassembler) Configure(args ...any) *Reassembler {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.applyArgs(args...)
	return r
}

func (r *Reassembler) configure(args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.applyArgs(args...)
}

func (r *Reassembler) applyArgs(args ...any) {
	ints := 0
	for _, arg := range args {
		switch v := arg.(type) {
		case Option:
			v(r)
		case Config:
			r.applyConfig(v)
		case *Config:
			if v != nil {
				r.applyConfig(*v)
			}
		case string:
			r.TruncationMarker = v
		case int:
			switch ints {
			case 0:
				r.MaxFragments = v
			case 1:
				r.MaxBytes = v
			}
			ints++
		case int64:
			r.currentGeneration = v
			r.currentGenerationKey = generationKey(v)
			r.generationSet = true
		}
	}
}

func (r *Reassembler) applyConfig(v Config) {
	if v.MaxBytes != 0 {
		r.MaxBytes = v.MaxBytes
	}
	if v.MaxSize != 0 {
		r.MaxSize = v.MaxSize
	}
	if v.MaxLength != 0 {
		r.MaxLength = v.MaxLength
	}
	if v.MaxFragments != 0 {
		r.MaxFragments = v.MaxFragments
	}
	if v.Limit != 0 {
		r.Limit = v.Limit
	}
	if v.MaxParts != 0 {
		r.MaxParts = v.MaxParts
	}
	if v.MaxRecordBytes != 0 {
		r.MaxRecordBytes = v.MaxRecordBytes
	}
	if v.MaxRecordFragments != 0 {
		r.MaxRecordFragments = v.MaxRecordFragments
	}
	if v.TruncationMarker != "" {
		r.TruncationMarker = v.TruncationMarker
	}
	if v.Marker != "" {
		r.Marker = v.Marker
	}
	if v.TruncatedMarker != "" {
		r.TruncatedMarker = v.TruncatedMarker
	}
	if v.Generation != nil {
		r.currentGeneration = v.Generation
		r.currentGenerationKey = generationKey(v.Generation)
		r.generationSet = true
	}
}

// Add processes one fragment and returns any records completed by it.
//
// records may be a Record, *Record, a CRI log line string, []byte, a
// struct/map with compatible fields, or a slice of these. Custom record types
// are matched by field name, so importing callers can feed their existing
// node-log entry type without an adapter.
func (r *Reassembler) Add(records ...any) []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}

	out := make([]Record, 0, 1)
	var sinks []func(Record)
	var appendValue func(any)
	appendValue = func(v any) {
		switch batch := v.(type) {
		case func(Record):
			sinks = append(sinks, batch)
		case func(*Record):
			sinks = append(sinks, func(rec Record) { batch(&rec) })
		case func(Record) error:
			sinks = append(sinks, func(rec Record) { _ = batch(rec) })
		case []Record:
			for _, rec := range batch {
				f, _ := normalizeRecord(rec)
				out = append(out, r.addFragment(f)...)
			}
		case []*Record:
			for _, rec := range batch {
				if rec != nil {
					f, _ := normalizeRecord(*rec)
					out = append(out, r.addFragment(f)...)
				}
			}
		case []string:
			for _, line := range batch {
				out = append(out, r.addLine(line)...)
			}
		case []any:
			for _, item := range batch {
				appendValue(item)
			}
		case string:
			out = append(out, r.addLine(batch)...)
		default:
			f, ok := normalize(v)
			if ok {
				out = append(out, r.addFragment(f)...)
			}
		}
	}
	for _, record := range records {
		appendValue(record)
	}
	for _, sink := range sinks {
		for _, rec := range out {
			sink(rec)
		}
	}
	return out
}

// Push is an alias for Add.
func (r *Reassembler) Push(records ...any) []Record { return r.Add(records...) }

// Feed is an alias for Add.
func (r *Reassembler) Feed(records ...any) []Record { return r.Add(records...) }

// Ingest is an alias for Add.
func (r *Reassembler) Ingest(records ...any) []Record { return r.Add(records...) }

// Process is an alias for Add.
func (r *Reassembler) Process(records ...any) []Record { return r.Add(records...) }

// Append is an alias for Add.
func (r *Reassembler) Append(records ...any) []Record { return r.Add(records...) }

// Consume is an alias for Add.
func (r *Reassembler) Consume(records ...any) []Record { return r.Add(records...) }

// WriteRecord is an alias for Add. It returns a single completed record when
// exactly one was produced by the last fragment.
func (r *Reassembler) WriteRecord(records ...any) (Record, bool) {
	out := r.Add(records...)
	if len(out) == 0 {
		return Record{}, false
	}
	return out[len(out)-1], true
}

// AddRecord is an alias for WriteRecord.
func (r *Reassembler) AddRecord(records ...any) (Record, bool) {
	return r.WriteRecord(records...)
}

// FeedRecord is an alias for WriteRecord.
func (r *Reassembler) FeedRecord(records ...any) (Record, bool) {
	return r.WriteRecord(records...)
}

// AddOne is an alias for WriteRecord.
func (r *Reassembler) AddOne(records ...any) (Record, bool) {
	return r.WriteRecord(records...)
}

// Next is an alias for WriteRecord.
func (r *Reassembler) Next(records ...any) (Record, bool) {
	return r.WriteRecord(records...)
}

// AddLine parses and adds one CRI line. Malformed lines produce no record.
// Use ParseLine when the error must be surfaced.
func (r *Reassembler) AddLine(line string) []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	return r.addLine(line)
}

// FeedLine is an alias for AddLine.
func (r *Reassembler) FeedLine(line string) []Record { return r.AddLine(line) }

// PushLine is an alias for AddLine.
func (r *Reassembler) PushLine(line string) []Record { return r.AddLine(line) }

// AddCRILine parses one line and returns at most one completed record.
func (r *Reassembler) AddCRILine(line string) (Record, bool) {
	out := r.AddLine(line)
	if len(out) == 0 {
		return Record{}, false
	}
	return out[len(out)-1], true
}

// FeedCRILine is an alias for AddCRILine.
func (r *Reassembler) FeedCRILine(line string) (Record, bool) {
	return r.AddCRILine(line)
}

func (r *Reassembler) addLine(line string) []Record {
	f, ok := normalize(line)
	if !ok {
		return nil
	}
	return r.addFragment(f)
}

func (r *Reassembler) addFragment(f fragment) []Record {
	if r.pending == nil {
		r.pending = make(map[recordKey]*pendingRecord)
	}
	out := r.ensureGeneration(&f)

	key := recordKey{
		stream:     f.stream,
		source:     f.source,
		timestamp:  f.timestampKey,
		generation: f.generationKey,
	}

	p := r.pending[key]
	if p == nil {
		if f.flag == TagFull {
			limited := f.content
			truncated := false
			if maxBytes := r.maxBytes(); maxBytes > 0 && len(limited) > maxBytes {
				limited = prefixBytes(limited, maxBytes)
				truncated = true
			}
			return append(out, r.outputRecord(f.record, limited, truncated))
		}
		p = &pendingRecord{
			key:   key,
			first: f.record,
			seq:   r.nextSeq,
		}
		r.nextSeq++
		r.pending[key] = p
	}

	if p.emitted {
		// The truncated result for this key has already been returned.
		// Consume the rest of the sequence so a later F cannot start a new
		// record with the same timestamp.
		if f.flag == TagFull {
			delete(r.pending, key)
		}
		return out
	}

	overflow, allowed := r.checkLimits(p, f.content)
	if overflow {
		if allowed > 0 {
			p.content.WriteString(prefixBytes(f.content, allowed))
			p.contentBytes += allowed
		}
		p.fragments++
		out = append(out, r.outputRecord(p.first, p.content.String(), true))
		p.emitted = true
		if f.flag == TagFull {
			delete(r.pending, key)
		}
		return out
	}

	p.content.WriteString(f.content)
	p.contentBytes += len(f.content)
	p.fragments++

	if f.flag == TagFull {
		delete(r.pending, key)
		return append(out, r.outputRecord(p.first, p.content.String(), false))
	}
	return out
}

func (r *Reassembler) ensureGeneration(f *fragment) []Record {
	if f.hasGeneration {
		if !r.generationSet {
			r.currentGeneration = f.generation
			r.currentGenerationKey = f.generationKey
			r.generationSet = true
			return nil
		}
		if f.generationKey != r.currentGenerationKey {
			out := r.flushLocked()
			r.currentGeneration = f.generation
			r.currentGenerationKey = f.generationKey
			return out
		}
		return nil
	}

	if !r.generationSet {
		r.currentGenerationKey = generationKey(r.currentGeneration)
		r.generationSet = true
	}
	f.generationKey = r.currentGenerationKey
	return nil
}

func (r *Reassembler) checkLimits(p *pendingRecord, content string) (overflow bool, allowed int) {
	maxBytes := r.maxBytes()
	maxFragments := r.maxFragments()

	if maxFragments > 0 && p.fragments+1 > maxFragments {
		return true, 0
	}
	if maxBytes > 0 && p.contentBytes+len(content) > maxBytes {
		allowed = maxBytes - p.contentBytes
		if allowed < 0 {
			allowed = 0
		}
		if allowed > len(content) {
			allowed = len(content)
		}
		return true, allowed
	}
	return false, 0
}

func (r *Reassembler) maxBytes() int {
	if r.MaxBytes != 0 {
		return r.MaxBytes
	}
	if r.MaxSize != 0 {
		return r.MaxSize
	}
	if r.MaxLength != 0 {
		return r.MaxLength
	}
	return r.MaxRecordBytes
}

func (r *Reassembler) maxFragments() int {
	if r.MaxFragments != 0 {
		return r.MaxFragments
	}
	if r.MaxParts != 0 {
		return r.MaxParts
	}
	if r.MaxRecordFragments != 0 {
		return r.MaxRecordFragments
	}
	return r.Limit
}

func (r *Reassembler) marker() string {
	if r.TruncationMarker != "" {
		return r.TruncationMarker
	}
	if r.Marker != "" {
		return r.Marker
	}
	if r.TruncatedMarker != "" {
		return r.TruncatedMarker
	}
	return TruncationMarker
}

func (r *Reassembler) outputRecord(base Record, content string, truncated bool) Record {
	out := base
	out.Content = content
	out.Partial = false
	if out.Source == "" && out.SourceTag != "" {
		out.Source = out.SourceTag
	}
	explicitSource := out.Source != ""
	if out.Source == "" {
		if out.Tag != "" && !isFlag(out.Tag) {
			out.Source = out.Tag
		}
	}
	if !explicitSource && out.Tag != "" && !isFlag(out.Tag) {
		// Tag was used as the source tag by the caller; preserve it.
	} else if out.Tag != "" {
		out.Tag = TagFull
	}
	if out.Flag != "" {
		out.Flag = TagFull
	}
	out.Truncated = truncated
	if out.Time == nil {
		switch {
		case out.Timestamp != nil:
			if t, err := parseTimestamp(out.Timestamp); err == nil {
				out.Time = t
			}
		case out.TimestampText != "":
			if t, err := parseTimestamp(out.TimestampText); err == nil {
				out.Time = t
			}
		}
	}
	if out.Message != "" {
		out.Message = content
	}
	if out.Data != "" {
		out.Data = content
	}
	if truncated {
		marker := r.marker()
		out.Content += marker
		if out.Message != "" {
			out.Message += marker
		}
		if out.Data != "" {
			out.Data += marker
		}
	}
	return out
}

func prefixBytes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if n >= len(s) {
		return s
	}
	return s[:n]
}

// Flush emits every pending partial sequence as one truncated record. It is
// used at EOF or whenever the caller knows no more fragments for the current
// file will arrive. Flush does not close the reassembler.
func (r *Reassembler) Flush(_ ...any) []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.flushLocked()
}

// Finish is an alias for Flush.
func (r *Reassembler) Finish() []Record { return r.Flush() }

// Finalize is an alias for Flush.
func (r *Reassembler) Finalize() []Record { return r.Flush() }

// Drain is an alias for Flush.
func (r *Reassembler) Drain() []Record { return r.Flush() }

// EOF is an alias for Flush.
func (r *Reassembler) EOF() []Record { return r.Flush() }

// Complete is an alias for Flush.
func (r *Reassembler) Complete() []Record { return r.Flush() }

// Close flushes and closes the reassembler. Subsequent Add calls are ignored.
func (r *Reassembler) Close() []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.flushLocked()
	r.closed = true
	return out
}

func (r *Reassembler) flushLocked() []Record {
	if len(r.pending) == 0 {
		return nil
	}
	items := make([]*pendingRecord, 0, len(r.pending))
	for _, p := range r.pending {
		items = append(items, p)
	}
	// Emit in the order the sequences started, which keeps output stable even
	// though pending records are stored in a map.
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j-1].seq > items[j].seq; j-- {
			items[j-1], items[j] = items[j], items[j-1]
		}
	}

	out := make([]Record, 0, len(items))
	for _, p := range items {
		if !p.emitted {
			out = append(out, r.outputRecord(p.first, p.content.String(), true))
			p.emitted = true
		}
		delete(r.pending, p.key)
	}
	return out
}

// Rotate begins a new file generation. Existing partial sequences are
// emitted as truncated records first, so they can never be joined to records
// from the new file. An optional argument sets the new generation; otherwise
// the current numeric generation is incremented.
func (r *Reassembler) Rotate(args ...any) []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.flushLocked()
	r.closed = false

	if len(args) > 0 {
		r.currentGeneration = args[0]
		r.currentGenerationKey = generationKey(args[0])
		r.generationSet = true
		return out
	}
	if n, ok := generationNumber(r.currentGeneration); ok {
		r.currentGeneration = n + 1
	} else {
		r.currentGeneration = time.Now().UnixNano()
	}
	r.currentGenerationKey = generationKey(r.currentGeneration)
	r.generationSet = true
	return out
}

// Roll is an alias for Rotate.
func (r *Reassembler) Roll(args ...any) []Record { return r.Rotate(args...) }

// NewFile is an alias for Rotate.
func (r *Reassembler) NewFile(args ...any) []Record { return r.Rotate(args...) }

// NextFile is an alias for Rotate.
func (r *Reassembler) NextFile(args ...any) []Record { return r.Rotate(args...) }

// Advance is an alias for Rotate.
func (r *Reassembler) Advance(args ...any) []Record { return r.Rotate(args...) }

// BeginFile is an alias for Rotate.
func (r *Reassembler) BeginFile(args ...any) []Record { return r.Rotate(args...) }

// StartFile is an alias for Rotate.
func (r *Reassembler) StartFile(args ...any) []Record { return r.Rotate(args...) }

// OnRotate is an alias for Rotate.
func (r *Reassembler) OnRotate(args ...any) []Record { return r.Rotate(args...) }

// SetGeneration starts a new file generation. Pending records from a
// different generation are emitted as truncated records.
func (r *Reassembler) SetGeneration(generation any) []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := generationKey(generation)
	if r.generationSet && key == r.currentGenerationKey {
		return nil
	}
	out := r.flushLocked()
	r.currentGeneration = generation
	r.currentGenerationKey = key
	r.generationSet = true
	return out
}

// SetFileGeneration is an alias for SetGeneration.
func (r *Reassembler) SetFileGeneration(generation any) []Record {
	return r.SetGeneration(generation)
}

// AdvanceGeneration is an alias for SetGeneration.
func (r *Reassembler) AdvanceGeneration(generation any) []Record {
	return r.SetGeneration(generation)
}

// SetFile is an alias for SetGeneration.
func (r *Reassembler) SetFile(generation any) []Record {
	return r.SetGeneration(generation)
}

// StartGeneration is an alias for SetGeneration.
func (r *Reassembler) StartGeneration(generation any) []Record {
	return r.SetGeneration(generation)
}

// NextGeneration is an alias for Rotate.
func (r *Reassembler) NextGeneration(args ...any) []Record {
	return r.Rotate(args...)
}

// Pending reports the number of partial sequences currently buffered.
func (r *Reassembler) Pending() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.pending)
}

// PendingCount is an alias for Pending.
func (r *Reassembler) PendingCount() int { return r.Pending() }

// Len is an alias for Pending.
func (r *Reassembler) Len() int { return r.Pending() }

// Reset discards buffered fragments and resets the generation.
func (r *Reassembler) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending = nil
	r.closed = false
	r.nextSeq = 0
	r.currentGeneration = nil
	r.currentGenerationKey = ""
	r.generationSet = false
}

// Clear is an alias for Reset.
func (r *Reassembler) Clear() { r.Reset() }

// Reassemble processes records and flushes the reassembler, returning both
// completed and truncated records.
func (r *Reassembler) Reassemble(records ...any) []Record {
	out := r.Add(records...)
	return append(out, r.Flush()...)
}

// AddAll is an alias for Reassemble.
func (r *Reassembler) AddAll(records ...any) []Record {
	return r.Reassemble(records...)
}

// Reassemble is a batch convenience function. Arguments may include records
// or lines and the same configuration values accepted by NewReassembler.
// The reassembler is flushed at the end, so missing final fragments are
// returned as truncated records rather than dropped.
func Reassemble(args ...any) []Record {
	r := NewReassembler()
	for _, arg := range args {
		if isConfigArg(arg) {
			r.Configure(arg)
		}
	}
	var out []Record
	for _, arg := range args {
		if isConfigArg(arg) {
			continue
		}
		out = append(out, r.Add(arg)...)
	}
	out = append(out, r.Flush()...)
	return out
}

// Merge is an alias for Reassemble.
func Merge(args ...any) []Record { return Reassemble(args...) }

// Combine is an alias for Reassemble.
func Combine(args ...any) []Record { return Reassemble(args...) }

// Assemble is an alias for Reassemble.
func Assemble(args ...any) []Record { return Reassemble(args...) }

// ProcessRecords is an alias for Reassemble.
func ProcessRecords(args ...any) []Record { return Reassemble(args...) }

// Process is a package-level alias for Reassemble.
func Process(args ...any) []Record { return Reassemble(args...) }

// ProcessLine parses and reassembles one CRI line. It flushes the temporary
// reassembler, so a P fragment is returned as a truncated record.
func ProcessLine(line string) []Record {
	return Reassemble(line)
}

// ReassembleRecords is an alias for Reassemble.
func ReassembleRecords(records []Record, args ...any) []Record {
	all := make([]any, 0, len(args)+len(records))
	all = append(all, args...)
	for _, rec := range records {
		all = append(all, rec)
	}
	return Reassemble(all...)
}

// MergeRecords is an alias for ReassembleRecords.
func MergeRecords(records []Record, args ...any) []Record {
	return ReassembleRecords(records, args...)
}

// CombineRecords is an alias for ReassembleRecords.
func CombineRecords(records []Record, args ...any) []Record {
	return ReassembleRecords(records, args...)
}

// AssembleRecords is an alias for ReassembleRecords.
func AssembleRecords(records []Record, args ...any) []Record {
	return ReassembleRecords(records, args...)
}

// ReassembleLines parses and reassembles CRI lines.
func ReassembleLines(lines []string, args ...any) []Record {
	all := make([]any, 0, len(args)+len(lines))
	all = append(all, args...)
	for _, line := range lines {
		all = append(all, line)
	}
	return Reassemble(all...)
}

// MergeLines is an alias for ReassembleLines.
func MergeLines(lines []string, args ...any) []Record {
	return ReassembleLines(lines, args...)
}

// ProcessLines is an alias for ReassembleLines.
func ProcessLines(lines []string, args ...any) []Record {
	return ReassembleLines(lines, args...)
}

func isConfigArg(v any) bool {
	switch v.(type) {
	case Option, Config, *Config:
		return true
	case int:
		return true
	case string:
		// A bare string in Reassemble is ambiguous: it could be a marker or a
		// log line. Treat only non-CRI-looking strings as configuration.
		_, err := ParseLine(v.(string))
		return err != nil
	default:
		return false
	}
}

func generationNumber(v any) (int64, bool) {
	switch g := v.(type) {
	case int:
		return int64(g), true
	case int8:
		return int64(g), true
	case int16:
		return int64(g), true
	case int32:
		return int64(g), true
	case int64:
		return g, true
	case uint:
		return int64(g), true
	case uint8:
		return int64(g), true
	case uint16:
		return int64(g), true
	case uint32:
		return int64(g), true
	case uint64:
		return int64(g), true
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(g), 10, 64)
		return n, err == nil
	case nil:
		return 0, true
	default:
		return 0, false
	}
}

// RecordKey returns the grouping key Reassembler uses for a record. It is
// exposed for diagnostics and tests. A non-nil generation overrides any
// generation present on the record.
func RecordKey(record Record, generation any) string {
	f, ok := normalizeRecord(record)
	if !ok {
		return ""
	}
	if generation != nil {
		f.generationKey = generationKey(generation)
	}
	if f.timestampKey == "" && f.hasTimestamp {
		f.timestampKey = timestampKey(f.timestamp)
	}
	return fmt.Sprintf("%s\x00%s\x00%s\x00%s", f.stream, f.source, f.timestampKey, f.generationKey)
}

package dataeng

import (
	"fmt"
	"sync"
	"time"
)

const defaultReplicaLabel = "__replica__"

// DefaultReplicaLabel is removed from external labels by default.
const DefaultReplicaLabel = defaultReplicaLabel

var defaultReplicaAliases = []string{"replica", "prometheus_replica"}

// Config controls partitioning and generation fencing.
type Config struct {
	// ReplicaLabel is removed from external labels before forming a partition
	// key. The default is "__replica__".
	ReplicaLabel string

	// ReplicaLabels can be used when an ingress accepts more than one spelling
	// of the replica label. All of them are removed from partition keys.
	ReplicaLabels []string

	// GroupLabels limits the external labels used for partitioning. When empty,
	// all external labels except the replica label(s) form the partition key.
	GroupLabels []string

	// DefaultGeneration is used by Add/AddSample and by batches that leave
	// Generation at zero.
	DefaultGeneration uint64

	// LeaderGeneration is an alias for DefaultGeneration.
	LeaderGeneration uint64

	// StrictGeneration rejects every sample from an older generation once a
	// newer generation has been observed in the partition. When false, an old
	// leader may fill timestamps that the new leader has not committed yet, but
	// it still cannot replace a timestamp committed by a newer generation.
	StrictGeneration bool
}

// Option configures a Deduplicator. Config itself is an Option, so callers may
// pass either Config{...} or the With... helpers.
type Option interface {
	apply(*Config)
}

type optionFunc func(*Config)

func (f optionFunc) apply(c *Config) {
	f(c)
}

func (c Config) apply(dst *Config) {
	*dst = copyConfig(c)
}

// WithReplicaLabel changes the label removed from external labels when a
// partition key is computed.
func WithReplicaLabel(name string) Option {
	return optionFunc(func(c *Config) {
		if name != "" {
			c.ReplicaLabel = name
		}
	})
}

// WithReplicaLabels adds replica label spellings to remove from partition keys.
func WithReplicaLabels(names ...string) Option {
	return optionFunc(func(c *Config) {
		c.ReplicaLabels = append([]string(nil), names...)
	})
}

// WithGroupLabels restricts partition keys to the named external labels.
func WithGroupLabels(names ...string) Option {
	return optionFunc(func(c *Config) {
		c.GroupLabels = append([]string(nil), names...)
	})
}

// WithLeaderGeneration sets the generation used when no per-batch generation
// is supplied.
func WithLeaderGeneration(generation uint64) Option {
	return optionFunc(func(c *Config) {
		c.DefaultGeneration = generation
	})
}

// WithStrictGeneration enables full generation fencing.
func WithStrictGeneration(strict bool) Option {
	return optionFunc(func(c *Config) {
		c.StrictGeneration = strict
	})
}

// Status classifies the result of an ingestion decision.
type Status string

const (
	StatusAccepted       Status = "accepted"
	StatusDuplicate      Status = "duplicate"
	StatusConflict       Status = "conflict"
	StatusStale          Status = "stale"
	StatusDuplicateStale Status = "duplicate_stale"
	StatusRejected       Status = "rejected"
)

// Decision describes what happened to one sample.
type Decision struct {
	Status             Status            `json:"status"`
	Sample             Sample            `json:"sample"`
	Existing           *Sample           `json:"existing,omitempty"`
	ExistingExemplar   *Exemplar         `json:"existing_exemplar,omitempty"`
	Generation         uint64            `json:"generation"`
	ExistingGeneration uint64            `json:"existing_generation,omitempty"`
	Replica            string            `json:"replica,omitempty"`
	Reason             string            `json:"reason,omitempty"`
	Conflict           *Conflict         `json:"conflict,omitempty"`
	ExemplarConflict   *ExemplarConflict `json:"exemplar_conflict,omitempty"`
}

// Accepted reports whether the incoming sample was newly committed.
func (d Decision) Accepted() bool {
	return d.Status == StatusAccepted || d.Status == StatusStale
}

// Duplicate reports whether the incoming identity was already committed.
func (d Decision) Duplicate() bool {
	return d.Status == StatusDuplicate || d.Status == StatusDuplicateStale
}

// Conflicting reports whether equal identities carried different value bits.
func (d Decision) Conflicting() bool {
	return d.Status == StatusConflict
}

// Stale reports whether the incoming sample was a stale marker.
func (d Decision) Stale() bool {
	return d.Status == StatusStale || d.Status == StatusDuplicateStale ||
		(d.Status != StatusRejected && d.Sample.Stale())
}

// Conflict describes two different value bit patterns for the same series and
// timestamp.
type Conflict struct {
	Labels             Labels `json:"labels"`
	Timestamp          int64  `json:"timestamp"`
	Existing           Sample `json:"existing"`
	Incoming           Sample `json:"incoming"`
	ExistingBits       uint64 `json:"existing_bits"`
	IncomingBits       uint64 `json:"incoming_bits"`
	ExistingGeneration uint64 `json:"existing_generation"`
	IncomingGeneration uint64 `json:"incoming_generation"`
	Resolved           bool   `json:"resolved"`
}

// Rejected describes a sample fenced by a newer leader generation.
type Rejected struct {
	Labels              Labels `json:"labels"`
	Timestamp           int64  `json:"timestamp"`
	Generation          uint64 `json:"generation"`
	CommittedGeneration uint64 `json:"committed_generation"`
	Reason              string `json:"reason"`
}

// ExemplarConflict is the exemplar equivalent of Conflict.
type ExemplarConflict struct {
	SeriesLabels       Labels   `json:"series_labels,omitempty"`
	Labels             Labels   `json:"labels"`
	Timestamp          int64    `json:"timestamp"`
	Existing           Exemplar `json:"existing"`
	Incoming           Exemplar `json:"incoming"`
	ExistingGeneration uint64   `json:"existing_generation"`
	IncomingGeneration uint64   `json:"incoming_generation"`
	Resolved           bool     `json:"resolved"`
}

// Result is returned by Ingest, Process and IngestBatch.
type Result struct {
	Accepted                  []Sample           `json:"accepted,omitempty"`
	Duplicates                []Sample           `json:"duplicates,omitempty"`
	Conflicts                 []Conflict         `json:"conflicts,omitempty"`
	ResolvedConflicts         []Conflict         `json:"resolved_conflicts,omitempty"`
	Stale                     []Sample           `json:"stale,omitempty"`
	Rejected                  []Rejected         `json:"rejected,omitempty"`
	RejectedExemplars         []Rejected         `json:"rejected_exemplars,omitempty"`
	Exemplars                 []Exemplar         `json:"exemplars,omitempty"`
	DuplicateExemplars        []Exemplar         `json:"duplicate_exemplars,omitempty"`
	ExemplarConflicts         []ExemplarConflict `json:"exemplar_conflicts,omitempty"`
	ResolvedExemplarConflicts []ExemplarConflict `json:"resolved_exemplar_conflicts,omitempty"`
}

// Batch is one remote-write request. External labels identify the sending
// replica; Generation identifies the elected leader generation.
//
// Samples carry their own series labels. Series may be used instead of Samples
// when the caller wants to associate exemplars with a series label set.
type Batch struct {
	ExternalLabels   Labels       `json:"external_labels,omitempty"`
	External         Labels       `json:"external,omitempty"`
	Replica          string       `json:"replica,omitempty"`
	Generation       uint64       `json:"generation,omitempty"`
	LeaderGeneration uint64       `json:"leader_generation,omitempty"`
	Epoch            uint64       `json:"epoch,omitempty"`
	Samples          []Sample     `json:"samples,omitempty"`
	Exemplars        []Exemplar   `json:"exemplars,omitempty"`
	Series           []TimeSeries `json:"series,omitempty"`
	Timeseries       []TimeSeries `json:"timeseries,omitempty"`
}

// WriteRequest is an alias commonly used at an HTTP/gRPC ingress.
type WriteRequest = Batch

type sampleEntry struct {
	sample     Sample
	generation uint64
	replica    string
}

type exemplarEntry struct {
	exemplar   Exemplar
	generation uint64
	replica    string
}

type seriesState struct {
	samples   map[int64]sampleEntry
	exemplars map[exemplarSlotKey]exemplarEntry
}

type groupState struct {
	generation uint64
	series     map[string]*seriesState
	committed  map[uint64]int64
}

// Deduplicator keeps committed sample identities. The zero value is ready for
// use and behaves as a single partition with replica label "__replica__".
type Deduplicator struct {
	mu     sync.Mutex
	config Config
	groups map[string]*groupState
}

// NewDeduplicator creates a deduplicator. Options are applied in order.
func NewDeduplicator(options ...Option) *Deduplicator {
	config := Config{ReplicaLabel: defaultReplicaLabel}
	for _, option := range options {
		if option != nil {
			option.apply(&config)
		}
	}
	if config.ReplicaLabel == "" {
		config.ReplicaLabel = defaultReplicaLabel
	}
	if config.DefaultGeneration == 0 {
		config.DefaultGeneration = config.LeaderGeneration
	}
	return &Deduplicator{
		config: config,
		groups: make(map[string]*groupState),
	}
}

// New returns a deduplicator configured with cfg.
func New(options ...Option) *Deduplicator {
	return NewDeduplicator(options...)
}

// Config returns a copy of the deduplicator configuration.
func (d *Deduplicator) Config() Config {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	return copyConfig(d.config)
}

// AddSample applies the configured default leader generation.
func (d *Deduplicator) AddSample(sample Sample) Decision {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	return d.addLocked("", d.config.DefaultGeneration, sample, nil)
}

// Add is an alias for AddSample.
func (d *Deduplicator) Add(sample Sample) Decision {
	return d.AddSample(sample)
}

// AddWithGeneration applies a sample in a specific external-label partition
// and leader generation.
func (d *Deduplicator) AddWithGeneration(external Labels, replica string, generation uint64, sample Sample) Decision {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	group := d.groupLocked(d.partitionKey(external))
	return d.addLocked(replica, generation, sample, group)
}

// AddExemplar applies an exemplar without an associated series label set.
func (d *Deduplicator) AddExemplar(exemplar Exemplar) Decision {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	group := d.groupLocked("")
	return d.addExemplarLocked(group, nil, "", d.config.DefaultGeneration, exemplar, nil)
}

// AddExemplarWithGeneration applies an exemplar in a specific partition and
// leader generation.
func (d *Deduplicator) AddExemplarWithGeneration(external Labels, replica string, generation uint64, exemplar Exemplar) Decision {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	group := d.groupLocked(d.partitionKey(external))
	return d.addExemplarLocked(group, nil, replica, generation, exemplar, nil)
}

// Ingest processes samples using the configured default generation and the
// empty external-label partition.
func (d *Deduplicator) Ingest(samples []Sample) Result {
	return d.IngestBatch(Batch{Samples: samples})
}

// Process is an alias for Ingest.
func (d *Deduplicator) Process(samples []Sample) Result {
	return d.Ingest(samples)
}

// Deduplicate is an alias for Ingest.
func (d *Deduplicator) Deduplicate(samples []Sample) Result {
	return d.Ingest(samples)
}

// IngestBatch processes a complete write request atomically with respect to
// concurrent callers.
func (d *Deduplicator) IngestBatch(batch Batch) Result {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()

	var result Result
	generation := batch.generation(d.config.DefaultGeneration)
	group := d.groupLocked(d.partitionKey(batch.externalLabels()))
	if generation > group.generation {
		group.generation = generation
	}

	for _, sample := range batch.Samples {
		decision := d.addLocked(batch.Replica, generation, sample, group)
		appendDecision(&result, decision)
	}
	seriesBatches := make([]TimeSeries, 0, len(batch.Series)+len(batch.Timeseries))
	seriesBatches = append(seriesBatches, batch.Series...)
	seriesBatches = append(seriesBatches, batch.Timeseries...)
	for _, series := range seriesBatches {
		seriesLabels := series.Labels
		for _, sample := range series.Samples {
			if sample.Labels == nil {
				sample.Labels = seriesLabels
			}
			decision := d.addLocked(batch.Replica, generation, sample, group)
			appendDecision(&result, decision)
		}
		for _, exemplar := range series.Exemplars {
			decision := d.addExemplarLocked(group, seriesLabels, batch.Replica, generation, exemplar, nil)
			appendExemplarDecision(&result, decision)
		}
	}
	for _, exemplar := range batch.Exemplars {
		decision := d.addExemplarLocked(group, nil, batch.Replica, generation, exemplar, nil)
		appendExemplarDecision(&result, decision)
	}
	return result
}

// SetGeneration advances the committed leader generation for an external-label
// partition. It never moves a partition backwards.
func (d *Deduplicator) SetGeneration(external Labels, generation uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	group := d.groupLocked(d.partitionKey(external))
	if generation > group.generation {
		group.generation = generation
	}
}

// SetDefaultGeneration changes the generation used by AddSample and by batches
// that do not carry a generation. Existing partition state is not rolled back.
func (d *Deduplicator) SetDefaultGeneration(generation uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	d.config.DefaultGeneration = generation
}

// Generation returns the newest committed leader generation for a partition.
func (d *Deduplicator) Generation(external ...Labels) uint64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	var labels Labels
	if len(external) != 0 {
		labels = external[0]
	}
	return d.groupLocked(d.partitionKey(labels)).generation
}

// Reset removes every committed identity and generation.
func (d *Deduplicator) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.groups = make(map[string]*groupState)
}

// HasSample reports whether the exact sample identity is committed in a
// partition.
func (d *Deduplicator) HasSample(external Labels, sample Sample) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	group := d.groups[d.partitionKey(external)]
	if group == nil {
		return false
	}
	series := group.series[d.seriesKey(sample.Labels)]
	if series == nil {
		return false
	}
	entry, ok := series.samples[sample.Timestamp]
	return ok && SameValue(entry.sample.Value, sample.Value)
}

// PruneBefore removes samples and exemplars older than the supplied timestamp.
// Timestamps are in whatever unit the caller uses (normally milliseconds).
func (d *Deduplicator) PruneBefore(timestamp int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensureLocked()
	for _, group := range d.groups {
		for seriesKey, series := range group.series {
			for ts := range series.samples {
				if ts < timestamp {
					delete(series.samples, ts)
				}
			}
			for key, entry := range series.exemplars {
				if entry.exemplar.Timestamp < timestamp {
					delete(series.exemplars, key)
				}
			}
			if len(series.samples) == 0 && len(series.exemplars) == 0 {
				delete(group.series, seriesKey)
			}
		}
	}
}

// PruneOlderThan is a time.Duration convenience wrapper around PruneBefore.
func (d *Deduplicator) PruneOlderThan(now time.Time, retention time.Duration) {
	d.PruneBefore(now.Add(-retention).UnixMilli())
}

func (d *Deduplicator) addLocked(replica string, generation uint64, sample Sample, group *groupState) Decision {
	if group == nil {
		group = d.groupLocked("")
	}
	if generation > group.generation {
		group.generation = generation
	}
	seriesKey := d.seriesKey(sample.Labels)
	series := group.series[seriesKey]
	if series == nil {
		series = &seriesState{
			samples:   make(map[int64]sampleEntry),
			exemplars: make(map[exemplarSlotKey]exemplarEntry),
		}
		group.series[seriesKey] = series
	}

	decision := Decision{
		Sample:     sample,
		Generation: generation,
		Replica:    replica,
	}
	if d.config.StrictGeneration && generation < group.generation {
		decision.Status = StatusRejected
		decision.ExistingGeneration = group.generation
		decision.Reason = "sample generation is older than the committed leader generation"
		return decision
	}
	if generation < group.generation && group.isBehindNewerWatermark(generation, sample.Timestamp) {
		decision.Status = StatusRejected
		decision.ExistingGeneration = group.generation
		decision.Reason = "sample generation is behind a timestamp committed by a newer leader generation"
		return decision
	}

	existing, ok := series.samples[sample.Timestamp]
	if !ok {
		series.samples[sample.Timestamp] = sampleEntry{
			sample:     sample,
			generation: generation,
			replica:    replica,
		}
		group.commit(generation, sample.Timestamp)
		decision.Status = StatusAccepted
		if sample.Stale() {
			decision.Status = StatusStale
		}
		return decision
	}

	existingCopy := existing.sample
	decision.Existing = &existingCopy
	if SameValue(existing.sample.Value, sample.Value) {
		if generation > existing.generation {
			existing.generation = generation
			existing.replica = replica
			series.samples[sample.Timestamp] = existing
		}
		group.commit(generation, sample.Timestamp)
		decision.Status = StatusDuplicate
		if sample.Stale() {
			decision.Status = StatusDuplicateStale
		}
		return decision
	}

	if generation < existing.generation {
		decision.Status = StatusRejected
		decision.ExistingGeneration = existing.generation
		decision.Reason = fmt.Sprintf(
			"late sample from generation %d cannot replace generation %d",
			generation,
			existing.generation,
		)
		return decision
	}
	if generation == existing.generation {
		decision.Status = StatusConflict
		decision.Reason = "same label set and timestamp with different value bits"
		decision.ExistingGeneration = existing.generation
		decision.Conflict = &Conflict{
			Labels:             sample.Labels.Clone(),
			Timestamp:          sample.Timestamp,
			Existing:           existing.sample,
			Incoming:           sample,
			ExistingBits:       ValueBits(existing.sample.Value),
			IncomingBits:       ValueBits(sample.Value),
			ExistingGeneration: existing.generation,
			IncomingGeneration: generation,
		}
		return decision
	}

	// A newer elected leader is authoritative for a timestamp it has committed.
	decision.Conflict = &Conflict{
		Labels:             sample.Labels.Clone(),
		Timestamp:          sample.Timestamp,
		Existing:           existing.sample,
		Incoming:           sample,
		ExistingBits:       ValueBits(existing.sample.Value),
		IncomingBits:       ValueBits(sample.Value),
		ExistingGeneration: existing.generation,
		IncomingGeneration: generation,
		Resolved:           true,
	}
	decision.ExistingGeneration = existing.generation
	series.samples[sample.Timestamp] = sampleEntry{
		sample:     sample,
		generation: generation,
		replica:    replica,
	}
	group.commit(generation, sample.Timestamp)
	decision.Status = StatusAccepted
	if sample.Stale() {
		decision.Status = StatusStale
	}
	decision.Reason = "replaced sample committed by an older leader generation"
	return decision
}

func (d *Deduplicator) addExemplarLocked(group *groupState, seriesLabels Labels, replica string, generation uint64, exemplar Exemplar, _ *exemplarEntry) Decision {
	if generation > group.generation {
		group.generation = generation
	}
	seriesKey := d.seriesKey(seriesLabels)
	series := group.series[seriesKey]
	if series == nil {
		series = &seriesState{
			samples:   make(map[int64]sampleEntry),
			exemplars: make(map[exemplarSlotKey]exemplarEntry),
		}
		group.series[seriesKey] = series
	}

	key := exemplarSlotKey{
		seriesLabels: seriesKey,
		labels:       KeyForLabels(exemplar.Labels),
		timestamp:    exemplar.Timestamp,
	}
	decision := Decision{
		Sample: Sample{
			Labels:    exemplar.Labels,
			Timestamp: exemplar.Timestamp,
			Value:     exemplar.Value,
		},
		Generation: generation,
		Replica:    replica,
	}
	if d.config.StrictGeneration && generation < group.generation {
		decision.Status = StatusRejected
		decision.ExistingGeneration = group.generation
		decision.Reason = "exemplar generation is older than the committed leader generation"
		return decision
	}
	if generation < group.generation && group.isBehindNewerWatermark(generation, exemplar.Timestamp) {
		decision.Status = StatusRejected
		decision.ExistingGeneration = group.generation
		decision.Reason = "exemplar generation is behind a timestamp committed by a newer leader generation"
		return decision
	}

	existing, ok := series.exemplars[key]
	if !ok {
		series.exemplars[key] = exemplarEntry{
			exemplar:   exemplar,
			generation: generation,
			replica:    replica,
		}
		group.commit(generation, exemplar.Timestamp)
		decision.Status = StatusAccepted
		return decision
	}

	existingCopy := existing.exemplar
	decision.ExistingExemplar = &existingCopy
	if SameValue(existing.exemplar.Value, exemplar.Value) {
		if generation > existing.generation {
			existing.generation = generation
			existing.replica = replica
			series.exemplars[key] = existing
		}
		group.commit(generation, exemplar.Timestamp)
		decision.Status = StatusDuplicate
		return decision
	}
	if generation < existing.generation {
		decision.Status = StatusRejected
		decision.ExistingGeneration = existing.generation
		decision.Reason = fmt.Sprintf(
			"late exemplar from generation %d cannot replace generation %d",
			generation,
			existing.generation,
		)
		return decision
	}
	if generation == existing.generation {
		decision.Status = StatusConflict
		decision.Reason = "same exemplar identity with different value bits"
		decision.ExistingGeneration = existing.generation
		decision.ExemplarConflict = &ExemplarConflict{
			SeriesLabels:       seriesLabels.Clone(),
			Labels:             exemplar.Labels.Clone(),
			Timestamp:          exemplar.Timestamp,
			Existing:           existing.exemplar,
			Incoming:           exemplar,
			ExistingGeneration: existing.generation,
			IncomingGeneration: generation,
		}
		return decision
	}

	decision.ExemplarConflict = &ExemplarConflict{
		SeriesLabels:       seriesLabels.Clone(),
		Labels:             exemplar.Labels.Clone(),
		Timestamp:          exemplar.Timestamp,
		Existing:           existing.exemplar,
		Incoming:           exemplar,
		ExistingGeneration: existing.generation,
		IncomingGeneration: generation,
		Resolved:           true,
	}
	decision.ExistingGeneration = existing.generation
	series.exemplars[key] = exemplarEntry{
		exemplar:   exemplar,
		generation: generation,
		replica:    replica,
	}
	group.commit(generation, exemplar.Timestamp)
	decision.Status = StatusAccepted
	decision.Reason = "replaced exemplar committed by an older leader generation"
	return decision
}

func (d *Deduplicator) groupLocked(key string) *groupState {
	if d.groups == nil {
		d.groups = make(map[string]*groupState)
	}
	group := d.groups[key]
	if group == nil {
		group = &groupState{
			series:    make(map[string]*seriesState),
			committed: make(map[uint64]int64),
		}
		d.groups[key] = group
	}
	if group.committed == nil {
		group.committed = make(map[uint64]int64)
	}
	return group
}

func (g *groupState) commit(generation uint64, timestamp int64) {
	if g.committed == nil {
		g.committed = make(map[uint64]int64)
	}
	if current, ok := g.committed[generation]; !ok || timestamp > current {
		g.committed[generation] = timestamp
	}
}

func (g *groupState) isBehindNewerWatermark(generation uint64, timestamp int64) bool {
	for candidate, watermark := range g.committed {
		if candidate > generation && timestamp <= watermark {
			return true
		}
	}
	return false
}

func (d *Deduplicator) ensureLocked() {
	if d.groups == nil {
		d.groups = make(map[string]*groupState)
	}
	if d.config.ReplicaLabel == "" {
		d.config.ReplicaLabel = defaultReplicaLabel
	}
	if d.config.DefaultGeneration == 0 {
		d.config.DefaultGeneration = d.config.LeaderGeneration
	}
}

func (d *Deduplicator) partitionKey(external Labels) string {
	remove := make(map[string]struct{}, len(d.config.ReplicaLabels)+len(defaultReplicaAliases)+1)
	if d.config.ReplicaLabel != "" {
		remove[d.config.ReplicaLabel] = struct{}{}
	}
	for _, name := range defaultReplicaAliases {
		remove[name] = struct{}{}
	}
	for _, name := range d.config.ReplicaLabels {
		if name != "" {
			remove[name] = struct{}{}
		}
	}

	labels := withoutLabels(external, remove)
	if len(d.config.GroupLabels) != 0 {
		projected := make(Labels, len(d.config.GroupLabels))
		for _, name := range d.config.GroupLabels {
			if value, ok := labels[name]; ok {
				projected[name] = value
			}
		}
		labels = projected
	}
	return KeyForLabels(labels)
}

func (d *Deduplicator) seriesKey(labels Labels) string {
	remove := make(map[string]struct{}, len(d.config.ReplicaLabels)+len(defaultReplicaAliases)+1)
	if d.config.ReplicaLabel != "" {
		remove[d.config.ReplicaLabel] = struct{}{}
	}
	for _, name := range defaultReplicaAliases {
		remove[name] = struct{}{}
	}
	for _, name := range d.config.ReplicaLabels {
		if name != "" {
			remove[name] = struct{}{}
		}
	}
	return KeyForLabels(withoutLabels(labels, remove))
}

func copyConfig(config Config) Config {
	config.ReplicaLabels = append([]string(nil), config.ReplicaLabels...)
	config.GroupLabels = append([]string(nil), config.GroupLabels...)
	return config
}

func (b Batch) externalLabels() Labels {
	if len(b.ExternalLabels) == 0 {
		return b.External
	}
	if len(b.External) == 0 {
		return b.ExternalLabels
	}
	merged := b.External.Clone()
	for name, value := range b.ExternalLabels {
		merged[name] = value
	}
	return merged
}

func (b Batch) generation(fallback uint64) uint64 {
	switch {
	case b.Generation != 0:
		return b.Generation
	case b.LeaderGeneration != 0:
		return b.LeaderGeneration
	case b.Epoch != 0:
		return b.Epoch
	default:
		return fallback
	}
}

func appendDecision(result *Result, decision Decision) {
	switch decision.Status {
	case StatusAccepted:
		result.Accepted = append(result.Accepted, decision.Sample)
	case StatusStale:
		result.Accepted = append(result.Accepted, decision.Sample)
		result.Stale = append(result.Stale, decision.Sample)
	case StatusDuplicate, StatusDuplicateStale:
		result.Duplicates = append(result.Duplicates, decision.Sample)
	case StatusRejected:
		result.Rejected = append(result.Rejected, Rejected{
			Labels:              decision.Sample.Labels,
			Timestamp:           decision.Sample.Timestamp,
			Generation:          decision.Generation,
			CommittedGeneration: decision.ExistingGeneration,
			Reason:              decision.Reason,
		})
	}
	if decision.Conflict != nil {
		result.Conflicts = append(result.Conflicts, *decision.Conflict)
	}
	if decision.Conflict != nil && decision.Conflict.Resolved {
		result.ResolvedConflicts = append(result.ResolvedConflicts, *decision.Conflict)
	}
}

func appendExemplarDecision(result *Result, decision Decision) {
	exemplar := Exemplar{
		Labels:    decision.Sample.Labels,
		Timestamp: decision.Sample.Timestamp,
		Value:     decision.Sample.Value,
	}
	switch decision.Status {
	case StatusAccepted, StatusStale:
		result.Exemplars = append(result.Exemplars, exemplar)
	case StatusDuplicate, StatusDuplicateStale:
		result.DuplicateExemplars = append(result.DuplicateExemplars, exemplar)
	case StatusRejected:
		result.RejectedExemplars = append(result.RejectedExemplars, Rejected{
			Labels:              exemplar.Labels,
			Timestamp:           exemplar.Timestamp,
			Generation:          decision.Generation,
			CommittedGeneration: decision.ExistingGeneration,
			Reason:              decision.Reason,
		})
	}
	if decision.ExemplarConflict != nil {
		result.ExemplarConflicts = append(result.ExemplarConflicts, *decision.ExemplarConflict)
	}
	if decision.ExemplarConflict != nil && decision.ExemplarConflict.Resolved {
		result.ResolvedExemplarConflicts = append(result.ResolvedExemplarConflicts, *decision.ExemplarConflict)
	}
}

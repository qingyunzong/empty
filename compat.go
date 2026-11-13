package dataeng

// LabelSet is an alias for Labels.
type LabelSet = Labels

// MetricSample is an alias for Sample.
type MetricSample = Sample

// Series is an alias for TimeSeries.
type Series = TimeSeries

// SampleStatus is an alias for Status.
type SampleStatus = Status

// DeduplicatorConfig is an alias for Config.
type DeduplicatorConfig = Config

// DedupConfig is an alias for Config.
type DedupConfig = Config

// Options is an alias for Config.
type Options = Config

// Settings is an alias for Config.
type Settings = Config

// DedupResult is an alias for Result.
type DedupResult = Result

// DeduplicationResult is an alias for Result.
type DeduplicationResult = Result

// BatchResult is an alias for Result.
type BatchResult = Result

// IngestResult is an alias for Result.
type IngestResult = Result

// NewDeduplicatorWithConfig creates a deduplicator from an explicit config.
func NewDeduplicatorWithConfig(config Config) *Deduplicator {
	return NewDeduplicator(config)
}

// Deduper is an alias for Deduplicator.
type Deduper = Deduplicator

// SampleDeduplicator is an alias for Deduplicator.
type SampleDeduplicator = Deduplicator

// NewDeduper is an alias for NewDeduplicator.
func NewDeduper(options ...Option) *Deduplicator {
	return NewDeduplicator(options...)
}

// NewSampleDeduplicator is an alias for NewDeduplicator.
func NewSampleDeduplicator(options ...Option) *Deduplicator {
	return NewDeduplicator(options...)
}

// DefaultConfig returns the constructor defaults.
func DefaultConfig() Config {
	return Config{ReplicaLabel: DefaultReplicaLabel}
}

// Deduplicate creates a fresh in-memory deduplicator and processes samples.
// Use a Deduplicator directly when identities must be remembered across
// requests.
func Deduplicate(samples []Sample) Result {
	return NewDeduplicator().Ingest(samples)
}

// DeduplicateSamples is an alias for Deduplicate.
func DeduplicateSamples(samples []Sample) Result {
	return Deduplicate(samples)
}

// DeduplicateBatch processes one complete write request with a fresh
// deduplicator.
func DeduplicateBatch(batch Batch) Result {
	return NewDeduplicator().IngestBatch(batch)
}

// Handle is an ingress-friendly alias for IngestBatch.
func (d *Deduplicator) Handle(batch Batch) Result {
	return d.IngestBatch(batch)
}

// Accept is an ingress-friendly alias for AddSample.
func (d *Deduplicator) Accept(sample Sample) Decision {
	return d.AddSample(sample)
}

// Observe is an ingress-friendly alias for AddSample.
func (d *Deduplicator) Observe(sample Sample) Decision {
	return d.AddSample(sample)
}

// DeduplicateSample is an alias for AddSample.
func (d *Deduplicator) DeduplicateSample(sample Sample) Decision {
	return d.AddSample(sample)
}

// ProcessSample is an alias for AddSample.
func (d *Deduplicator) ProcessSample(sample Sample) Decision {
	return d.AddSample(sample)
}

// IngestExemplar is an alias for AddExemplar.
func (d *Deduplicator) IngestExemplar(exemplar Exemplar) Decision {
	return d.AddExemplar(exemplar)
}

// IngestExemplars processes exemplars using the empty partition and the
// configured default generation.
func (d *Deduplicator) IngestExemplars(exemplars []Exemplar) Result {
	return d.IngestBatch(Batch{Exemplars: exemplars})
}

// DeduplicateExemplars processes exemplars with a fresh deduplicator.
func DeduplicateExemplars(exemplars []Exemplar) Result {
	return NewDeduplicator().IngestExemplars(exemplars)
}

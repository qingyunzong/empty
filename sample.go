package dataeng

import "math"

// StaleNaNBits is the bit pattern Prometheus remote-write senders use for a
// stale marker. It must not be used for ordinary NaN values.
const StaleNaNBits uint64 = 0x7ff0000000000002

// StaleNaN is the floating point representation of StaleNaNBits.
var StaleNaN = math.Float64frombits(StaleNaNBits)

// ValueBits returns the raw IEEE 754 representation of v. Using bits makes the
// identity independent of float comparison rules and preserves NaN payloads.
func ValueBits(v float64) uint64 {
	return math.Float64bits(v)
}

// Bits returns the raw IEEE 754 representation of s.Value.
func (s Sample) Bits() uint64 {
	return ValueBits(s.Value)
}

// SampleFromBits constructs a sample from an exact value bit pattern.
func SampleFromBits(labels Labels, timestamp int64, bits uint64) Sample {
	return Sample{
		Labels:    labels,
		Timestamp: timestamp,
		Value:     math.Float64frombits(bits),
	}
}

// StaleValue returns the Prometheus stale marker value.
func StaleValue() float64 {
	return math.Float64frombits(StaleNaNBits)
}

// SameValue reports whether two values have identical IEEE 754 bits.
func SameValue(a, b float64) bool {
	return ValueBits(a) == ValueBits(b)
}

// IsStaleNaN reports whether v is the Prometheus stale marker.
func IsStaleNaN(v float64) bool {
	return ValueBits(v) == StaleNaNBits
}

// IsStaleMarker is an alias for IsStaleNaN.
func IsStaleMarker(v float64) bool {
	return IsStaleNaN(v)
}

// Kind classifies a value carried by a sample or exemplar.
type Kind uint8

// ValueKind is an alias for Kind.
type ValueKind = Kind

const (
	KindValue Kind = iota
	KindStale
	KindExemplar
)

// Kind returns KindStale for the Prometheus stale marker and KindValue
// otherwise.
func (s Sample) Kind() Kind {
	if s.Stale() {
		return KindStale
	}
	return KindValue
}

// Kind always reports KindExemplar. Exemplars are kept separate from sample
// identities even when their value happens to be the stale NaN.
func (e Exemplar) Kind() Kind {
	return KindExemplar
}

// Sample is one remote-write sample.
type Sample struct {
	Labels    Labels  `json:"labels"`
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
}

// SampleKey is the complete identity of a sample.
type SampleKey struct {
	Labels    string `json:"labels"`
	Timestamp int64  `json:"timestamp"`
	ValueBits uint64 `json:"value_bits"`
}

// Key returns the complete identity of s.
func (s Sample) Key() SampleKey {
	return SampleKey{
		Labels:    KeyForLabels(s.Labels),
		Timestamp: s.Timestamp,
		ValueBits: ValueBits(s.Value),
	}
}

// Stale reports whether s is a stale marker.
func (s Sample) Stale() bool {
	return IsStaleNaN(s.Value)
}

// Exemplar is one remote-write exemplar. Exemplars have their own label set
// (for example a trace_id) and are deduplicated independently from samples.
type Exemplar struct {
	Labels    Labels  `json:"labels"`
	Timestamp int64   `json:"timestamp"`
	Value     float64 `json:"value"`
}

// ExemplarKey is the complete identity of an exemplar.
type ExemplarKey struct {
	SeriesLabels string `json:"series_labels,omitempty"`
	Labels       string `json:"labels"`
	Timestamp    int64  `json:"timestamp"`
	ValueBits    uint64 `json:"value_bits"`
}

// Key returns the complete identity of e without a series label set.
func (e Exemplar) Key() ExemplarKey {
	return ExemplarKey{
		Labels:    KeyForLabels(e.Labels),
		Timestamp: e.Timestamp,
		ValueBits: ValueBits(e.Value),
	}
}

type exemplarSlotKey struct {
	seriesLabels string
	labels       string
	timestamp    int64
}

// TimeSeries groups samples and exemplars that share a series label set.
type TimeSeries struct {
	Labels    Labels     `json:"labels"`
	Samples   []Sample   `json:"samples,omitempty"`
	Exemplars []Exemplar `json:"exemplars,omitempty"`
}

package dataeng

import "time"

// RegionSource is the integration point for a global SaaS connector.
// Each connector implementation returns the records its region currently
// knows about. A region that is temporarily unreachable should return an
// error rather than an empty record set: empty means "no versions", never
// "delete everything", and the store never derives tombstones from a gap.
type RegionSource interface {
	RegionID() string
	Pull() ([]Record, error)
}

// SourceFunc adapts a pull function into a RegionSource.
type SourceFunc struct {
	ID     string
	PullFn func() ([]Record, error)
}

// RegionID implements RegionSource.
func (f SourceFunc) RegionID() string { return f.ID }

// Pull implements RegionSource.
func (f SourceFunc) Pull() ([]Record, error) { return f.PullFn() }

// IngestResult summarizes one connector ingest or replay pass.
type IngestResult struct {
	Region    string
	Accepted  int
	Duplicate int
	Stale     int
	Conflicts int
	// Offline indicates the region could not be reached; in that case no
	// record was applied and no deletion was generated.
	Offline bool
}

// Ingest pulls one region through its connector and merges every returned
// record. Pull failures leave the store untouched and report Offline, so a
// transient outage cannot erase data.
func (s *Store) Ingest(source RegionSource) (IngestResult, error) {
	if source == nil {
		return IngestResult{}, ErrNilSource
	}

	records, err := source.Pull()
	if err != nil {
		return IngestResult{Region: source.RegionID(), Offline: true}, err
	}

	results, err := s.ApplyBatch(records)
	if err != nil {
		return IngestResult{Region: source.RegionID(), Offline: true}, err
	}

	summary := IngestResult{Region: source.RegionID()}
	for _, result := range results {
		switch {
		case result.Accepted:
			summary.Accepted++
		case result.Duplicate:
			summary.Duplicate++
		case result.Stale:
			summary.Stale++
		}
		if result.Conflicts > summary.Conflicts {
			summary.Conflicts = result.Conflicts
		}
	}
	return summary, nil
}

// Replay re-applies a connector's buffered event log after a region
// recovers. It is identical to Ingest by construction: EventID
// deduplication plus equal-vector handling make the replayed prefix a
// no-op, so retries at any offset are safe.
func (s *Store) Replay(source RegionSource) (IngestResult, error) {
	return s.Ingest(source)
}

// DisplayUpdatedAt returns the wall-clock timestamp of a key's effective
// version for UI display only. It never feeds merge adjudication. The
// boolean is false for unknown keys.
func (s *Store) DisplayUpdatedAt(key string) (time.Time, bool) {
	rec, ok := s.Effective(key)
	if !ok {
		return time.Time{}, false
	}
	return rec.UpdatedAt, true
}

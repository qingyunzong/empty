package dataeng

import "time"

type storedRecord struct {
	rec        Record
	seq        uint64
	fromUpload bool
}

// recordSet is a mutable staging structure. Snapshots never expose it; they
// build their own sorted, read-only structures from a stable copy.
type recordSet struct {
	byKey map[string]map[string]storedRecord
	size  int
}

func newRecordSet() *recordSet {
	return &recordSet{byKey: make(map[string]map[string]storedRecord)}
}

func (rs *recordSet) clone() *recordSet {
	out := &recordSet{
		byKey: make(map[string]map[string]storedRecord, len(rs.byKey)),
		size:  rs.size,
	}
	for key, versions := range rs.byKey {
		m := make(map[string]storedRecord, len(versions))
		for id, entry := range versions {
			m[id] = entry
		}
		out.byKey[key] = m
	}
	return out
}

func (rs *recordSet) get(key, versionID string) (storedRecord, bool) {
	versions, ok := rs.byKey[key]
	if !ok {
		return storedRecord{}, false
	}
	entry, ok := versions[versionID]
	return entry, ok
}

// put inserts or merges one record. It reports whether a new identity was
// added, whether an existing identity changed, or whether the input was an
// exact duplicate. nextSeq is called only when new ordering information is
// needed, keeping duplicate pages from perturbing the snapshot order.
func (rs *recordSet) put(rec Record, fromUpload bool, nextSeq func() uint64) (added, updated, duplicate bool, err error) {
	versions := rs.byKey[rec.Key]
	if versions == nil {
		versions = make(map[string]storedRecord)
		rs.byKey[rec.Key] = versions
	}

	cur, ok := versions[rec.VersionID]
	if !ok {
		versions[rec.VersionID] = storedRecord{rec: rec, seq: nextSeq(), fromUpload: fromUpload}
		rs.size++
		return true, false, false, nil
	}
	if cur.rec.DeleteMarker != rec.DeleteMarker {
		return false, false, false, ErrRecordConflict
	}

	merged := mergeRecords(cur.rec, rec)
	if equalRecords(cur.rec, merged) {
		if fromUpload && !cur.fromUpload {
			cur.fromUpload = true
			versions[rec.VersionID] = cur
		}
		return false, false, true, nil
	}
	versions[rec.VersionID] = storedRecord{
		rec:        merged,
		seq:        nextSeq(),
		fromUpload: cur.fromUpload || fromUpload,
	}
	return false, true, false, nil
}

// mergeRecords reconciles two observations of the same immutable S3 version.
// The newest observation supplies the payload, while IsLatest is monotonic so
// an overlapping page cannot clear a flag learned from another page.
func mergeRecords(cur, incoming Record) Record {
	out := cur
	useIncoming := incoming.LastModified.After(cur.LastModified) ||
		(cur.LastModified.IsZero() && !incoming.LastModified.IsZero())

	if useIncoming {
		out.LastModified = incoming.LastModified
		out.ETag = incoming.ETag
		out.Size = incoming.Size
		out.Owner = incoming.Owner
		out.StorageClass = incoming.StorageClass
	} else {
		if out.ETag == "" {
			out.ETag = incoming.ETag
		}
		if out.Owner == "" {
			out.Owner = incoming.Owner
		}
		if out.StorageClass == "" {
			out.StorageClass = incoming.StorageClass
		}
		if out.Size == 0 {
			out.Size = incoming.Size
		}
	}
	out.IsLatest = cur.IsLatest || incoming.IsLatest
	return out
}

func equalRecords(a, b Record) bool {
	return a.Key == b.Key &&
		a.VersionID == b.VersionID &&
		a.DeleteMarker == b.DeleteMarker &&
		a.IsLatest == b.IsLatest &&
		a.LastModified.Equal(b.LastModified) &&
		a.ETag == b.ETag &&
		a.Size == b.Size &&
		a.Owner == b.Owner &&
		a.StorageClass == b.StorageClass
}

func (rs *recordSet) merge(src *recordSet) error {
	for _, versions := range src.byKey {
		for _, entry := range versions {
			cur, ok := rs.get(entry.rec.Key, entry.rec.VersionID)
			if !ok {
				m := rs.byKey[entry.rec.Key]
				if m == nil {
					m = make(map[string]storedRecord)
					rs.byKey[entry.rec.Key] = m
				}
				m[entry.rec.VersionID] = entry
				rs.size++
				continue
			}
			if cur.rec.DeleteMarker != entry.rec.DeleteMarker {
				return ErrRecordConflict
			}
			merged := mergeRecords(cur.rec, entry.rec)
			seq := cur.seq
			if entry.seq > seq {
				seq = entry.seq
			}
			m := rs.byKey[entry.rec.Key]
			m[entry.rec.VersionID] = storedRecord{
				rec:        merged,
				seq:        seq,
				fromUpload: cur.fromUpload || entry.fromUpload,
			}
		}
	}
	return nil
}

func stampUploadTime(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t
}

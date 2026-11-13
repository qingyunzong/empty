package dataeng

import (
	"cmp"
	"fmt"
	"time"
)

// ObjectVersion is the version-shaped input from a ListObjectVersions page.
//
// VersionId is accepted as a spelling-compatible alias for VersionID; AWS SDK
// v1 used VersionId. If both are set they must match.
type ObjectVersion struct {
	Key          string
	VersionID    string
	VersionId    string
	IsLatest     bool
	LastModified time.Time
	ETag         string
	Size         int64
	Owner        string
	StorageClass string
}

// DeleteMarker is the delete-marker-shaped input from a ListObjectVersions
// page. Delete markers do not have an ETag, size, or storage class.
//
// VersionId is accepted as a spelling-compatible alias for VersionID.
type DeleteMarker struct {
	Key          string
	VersionID    string
	VersionId    string
	IsLatest     bool
	LastModified time.Time
	Owner        string
}

// Marker is an S3 ListObjectVersions continuation cursor. The pair is ordered
// by key first and then by version ID.
type Marker struct {
	KeyMarker       string
	VersionIDMarker string
}

// IsZero reports whether the cursor is the initial cursor of a traversal.
func (m Marker) IsZero() bool {
	return m.KeyMarker == "" && m.VersionIDMarker == ""
}

func (m Marker) String() string {
	return fmt.Sprintf("(key=%q, version=%q)", m.KeyMarker, m.VersionIDMarker)
}

func compareMarkers(a, b Marker) int {
	if n := cmp.Compare(a.KeyMarker, b.KeyMarker); n != 0 {
		return n
	}
	return cmp.Compare(a.VersionIDMarker, b.VersionIDMarker)
}

// Page is one ListObjectVersions response.
//
// The KeyMarker and VersionIDMarker fields describe the request that produced
// the page. The store relies on NextKeyMarker and NextVersionIDMarker to detect
// progress. NextVersionIdMarker is accepted as an alias for
// NextVersionIDMarker. VersionIdMarker is accepted as an alias for
// VersionIDMarker.
type Page struct {
	Prefix          string
	Delimiter       string
	KeyMarker       string
	VersionIDMarker string
	VersionIdMarker string

	NextKeyMarker       string
	NextVersionIDMarker string
	NextVersionIdMarker string

	IsTruncated    bool
	Versions       []ObjectVersion
	DeleteMarkers  []DeleteMarker
	CommonPrefixes []string
}

// NextMarker returns the continuation marker advertised by the page.
func (p Page) NextMarker() (Marker, error) {
	id, err := pickOptionalVersionID(p.NextVersionIDMarker, p.NextVersionIdMarker)
	if err != nil {
		return Marker{}, err
	}
	return Marker{KeyMarker: p.NextKeyMarker, VersionIDMarker: id}, nil
}

// Record is the store's unified version/delete-marker entry. It is immutable
// once returned from a Snapshot. DeleteMarker distinguishes a delete marker
// from a regular object version.
type Record struct {
	Key          string
	VersionID    string
	DeleteMarker bool
	IsLatest     bool
	LastModified time.Time
	ETag         string
	Size         int64
	Owner        string
	StorageClass string
}

// Convenience names for the unified record type.
type (
	Version       = Record
	VersionRecord = Record
	Entry         = Record

	Inventory           = Store
	InventoryStore      = Store
	InventorySnapshot   = Snapshot
	InventoryGeneration = Generation

	PageResult             = ApplyResult
	ListObjectVersionsPage = Page

	LatestView  = []Record
	HistoryView = []Record
)

// ApplyResult reports the effect of one ingested page.
type ApplyResult struct {
	// Records is the number of version and delete-marker entries in the page.
	Records int
	// Added counts identities not previously present in the generation.
	Added int
	// Updated counts existing identities whose metadata or IsLatest flag
	// changed as a result of the page.
	Updated int
	// Duplicates counts identities that were already present unchanged.
	Duplicates int
	// Truncated copies Page.IsTruncated.
	Truncated bool
	// Complete reports that this page ended the traversal.
	Complete bool
	// MarkerAdvanced reports whether a truncated page moved the continuation
	// cursor strictly forward.
	MarkerAdvanced bool
	// Stalled reports that a truncated page did not move the cursor. The page's
	// records were still merged idempotently, but the traversal cannot publish.
	Stalled bool
	// Marker is the generation cursor after the page. When a page is stalled,
	// it remains the previous cursor.
	Marker Marker
}

// Progress is a read-only view of a staging generation's traversal.
type Progress struct {
	Generation uint64
	Pages      int
	Records    int
	Marker     Marker
	Complete   bool
}

func (v ObjectVersion) record() (Record, error) {
	id, err := pickVersionID(v.VersionID, v.VersionId)
	if err != nil {
		return Record{}, fmt.Errorf("%w: version for key %q: %v", ErrInvalidPage, v.Key, err)
	}
	if v.Key == "" {
		return Record{}, fmt.Errorf("%w: version has an empty key", ErrInvalidPage)
	}
	return Record{
		Key:          v.Key,
		VersionID:    id,
		IsLatest:     v.IsLatest,
		LastModified: v.LastModified,
		ETag:         v.ETag,
		Size:         v.Size,
		Owner:        v.Owner,
		StorageClass: v.StorageClass,
	}, nil
}

func (d DeleteMarker) record() (Record, error) {
	id, err := pickVersionID(d.VersionID, d.VersionId)
	if err != nil {
		return Record{}, fmt.Errorf("%w: delete marker for key %q: %v", ErrInvalidPage, d.Key, err)
	}
	if d.Key == "" {
		return Record{}, fmt.Errorf("%w: delete marker has an empty key", ErrInvalidPage)
	}
	return Record{
		Key:          d.Key,
		VersionID:    id,
		DeleteMarker: true,
		IsLatest:     d.IsLatest,
		LastModified: d.LastModified,
		Owner:        d.Owner,
	}, nil
}

func (p Page) records() ([]Record, error) {
	out := make([]Record, 0, len(p.Versions)+len(p.DeleteMarkers))
	for _, v := range p.Versions {
		r, err := v.record()
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	for _, d := range p.DeleteMarkers {
		r, err := d.record()
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func pickVersionID(primary, alias string) (string, error) {
	switch {
	case primary != "" && alias != "" && primary != alias:
		return "", fmt.Errorf("VersionID %q and VersionId %q disagree", primary, alias)
	case primary != "":
		return primary, nil
	case alias != "":
		return alias, nil
	default:
		// ListObjectVersions uses "null" for objects in unversioned buckets.
		// Keeping that sentinel rather than failing on an omitted fixture field
		// preserves a stable identity for those objects.
		return "null", nil
	}
}

func pickOptionalVersionID(primary, alias string) (string, error) {
	switch {
	case primary != "" && alias != "" && primary != alias:
		return "", fmt.Errorf("NextVersionIDMarker %q and NextVersionIdMarker %q disagree", primary, alias)
	case primary != "":
		return primary, nil
	default:
		return alias, nil
	}
}

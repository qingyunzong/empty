// Package backupverify verifies backup chains: a full manifest followed by
// incremental packages linked by parent digests.
package backupverify

// ObjectVersion is one versioned record of an object. A record with
// Deleted=true is a tombstone; otherwise Chunks holds the ordered chunk
// references that make up the object content.
type ObjectVersion struct {
	ID      string   `json:"id"`
	Version int      `json:"version"`
	Deleted bool     `json:"deleted,omitempty"`
	Chunks  []string `json:"chunks,omitempty"`
}

// Manifest is a full snapshot: the root of a backup chain.
type Manifest struct {
	Objects []ObjectVersion `json:"objects"`
}

// Op is a single mutation inside an incremental package. Kind is "put"
// (replace content of id@version) or "delete" (tombstone id@version).
type Op struct {
	Kind    string   `json:"kind"`
	ID      string   `json:"id"`
	Version int      `json:"version"`
	Chunks  []string `json:"chunks,omitempty"`
}

// Package is an incremental unit chained to its predecessor by Parent,
// which must equal the digest of the previous package (or of the manifest
// for the first package).
type Package struct {
	Parent string `json:"parent"`
	Ops    []Op   `json:"ops"`
}

// Digest returns the content digest of the manifest.
func (m *Manifest) Digest() string {
	objs := make([]ObjectVersion, len(m.Objects))
	copy(objs, m.Objects)
	sortObjectVersions(objs)
	return digestOf(map[string]any{"type": "full", "objects": objs})
}

// Digest returns the content digest of the package, covering its parent
// link and its ops in order.
func (p *Package) Digest() string {
	return digestOf(map[string]any{"type": "incremental", "parent": p.Parent, "ops": p.Ops})
}

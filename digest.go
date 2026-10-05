package backupverify

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// digestOf computes a stable sha256 digest over a JSON-encodable value.
// encoding/json sorts map keys, so the encoding is canonical.
func digestOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func sortObjectVersions(objs []ObjectVersion) {
	sort.Slice(objs, func(i, j int) bool {
		if objs[i].ID != objs[j].ID {
			return objs[i].ID < objs[j].ID
		}
		return objs[i].Version < objs[j].Version
	})
}

// sameContent reports whether two records of the same object version carry
// identical content (tombstone state plus ordered chunk list).
func sameContent(a, b ObjectVersion) bool {
	if a.Deleted != b.Deleted {
		return false
	}
	if len(a.Chunks) != len(b.Chunks) {
		return false
	}
	for i := range a.Chunks {
		if a.Chunks[i] != b.Chunks[i] {
			return false
		}
	}
	return true
}

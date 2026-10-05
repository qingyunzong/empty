package store

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// VerifyReport summarizes a full on-disk audit of a store directory.
type VerifyReport struct {
	Generation uint64
	Pages      int

	// BadPages holds page IDs whose stored record failed checksum or
	// structural validation.
	BadPages []uint64
	// MissingSegments are referenced by the committed index but absent
	// from disk.
	MissingSegments []uint64
	// OrphanSegments are present on disk but outside the reclamation
	// range of the committed generation (they should have been retired).
	OrphanSegments []uint64
	// StrayFiles are leftover temp files or index logs of other
	// generations.
	StrayFiles []string
}

// OK reports whether the audit found no problems.
func (r *VerifyReport) OK() bool {
	return len(r.BadPages) == 0 && len(r.MissingSegments) == 0 &&
		len(r.OrphanSegments) == 0 && len(r.StrayFiles) == 0
}

func (r *VerifyReport) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "generation=%d pages=%d", r.Generation, r.Pages)
	if r.OK() {
		b.WriteString(" status=OK")
		return b.String()
	}
	fmt.Fprintf(&b, " badPages=%v missingSegments=%v orphanSegments=%v strayFiles=%v",
		r.BadPages, r.MissingSegments, r.OrphanSegments, r.StrayFiles)
	return b.String()
}

// Verify audits dir without mutating it: every page referenced by the
// committed generation's index is read back and its checksum verified,
// and the on-disk segment set is checked against the reclamation range
// (referenced segments must exist, everything else must be gone).
func Verify(dir string) (*VerifyReport, error) {
	report := &VerifyReport{}

	generation, err := readCommit(dir)
	if err != nil {
		return nil, err
	}
	report.Generation = generation

	index := make(map[uint64]Location)
	if generation > 0 || fileExists(filepath.Join(dir, indexFileName(generation))) {
		_, entries, err := loadIndex(filepath.Join(dir, indexFileName(generation)))
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			index[e.PageID] = e.Loc
		}
	}
	report.Pages = len(index)

	// Per-page checksum audit.
	ids := make([]uint64, 0, len(index))
	for id := range index {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if _, err := readPage(dir, id, index[id]); err != nil {
			report.BadPages = append(report.BadPages, id)
		}
	}

	// Reclamation-range audit.
	referenced := make(map[uint64]bool)
	for _, loc := range index {
		referenced[loc.Segment] = true
	}
	onDisk := make(map[uint64]bool)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		name := e.Name()
		if id, ok := parseSegFileName(name); ok {
			onDisk[id] = true
			if !referenced[id] {
				report.OrphanSegments = append(report.OrphanSegments, id)
			}
			continue
		}
		if gen, ok := parseIndexFileName(name); ok && gen != generation {
			report.StrayFiles = append(report.StrayFiles, name)
			continue
		}
		if strings.HasSuffix(name, ".tmp") {
			report.StrayFiles = append(report.StrayFiles, name)
		}
	}
	for id := range referenced {
		if !onDisk[id] {
			report.MissingSegments = append(report.MissingSegments, id)
		}
	}
	sort.Slice(report.MissingSegments, func(i, j int) bool { return report.MissingSegments[i] < report.MissingSegments[j] })
	sort.Slice(report.OrphanSegments, func(i, j int) bool { return report.OrphanSegments[i] < report.OrphanSegments[j] })
	sort.Strings(report.StrayFiles)
	return report, nil
}

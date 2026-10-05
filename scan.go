package fileindex

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// Scanner walks one or more directories and publishes the collected
// entries into the cache.
type Scanner struct {
	cache *Cache
	// BeforePublish, when non-nil, runs after the baseline has been
	// captured and the entries collected, immediately before baseline
	// validation and publish. Tests use it as a barrier to interleave
	// mutations deterministically.
	BeforePublish func()
}

// Scanner returns a Scanner publishing into c.
func (c *Cache) Scanner() *Scanner { return &Scanner{cache: c} }

// Result is the outcome of one scan.
type Result struct {
	// Entries are the entries collected during the scan, tagged with
	// the baseline generation of their path. They are returned even
	// when publication was rejected, so callers can inspect (or
	// compare) the stale view.
	Entries []Entry
	// Published is true only when every baseline generation was still
	// valid at publish time and the cache was updated.
	Published bool
}

// Scan walks dirs, collects one entry per regular file, and attempts
// to publish them into the cache. Publication is all-or-nothing across
// all dirs: it happens only if every baseline generation captured at
// scan start is still valid. A delete/recreate of any scanned path in
// the meantime bumps its generation and causes rejection.
func (s *Scanner) Scan(dirs ...string) (Result, error) {
	var paths []string
	for _, dir := range dirs {
		err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.Type().IsRegular() {
				paths = append(paths, p)
			}
			return nil
		})
		if err != nil {
			return Result{}, err
		}
	}
	sort.Strings(paths)

	c := s.cache
	baseline := c.snapshot(paths)

	entries := make([]Entry, 0, len(paths))
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			// The file vanished mid-scan; the corresponding Delete
			// notification bumps its generation and rejects the
			// publish, so no stale entry is ever stored.
			continue
		}
		entries = append(entries, Entry{
			Path:        p,
			Generation:  baseline[p],
			Size:        info.Size(),
			ModTimeUnix: info.ModTime().Unix(),
		})
	}

	if s.BeforePublish != nil {
		s.BeforePublish()
	}

	published := c.publish(baseline, entries)
	return Result{Entries: entries, Published: published}, nil
}

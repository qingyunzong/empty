package merklefs

import "fmt"

// ChangeKind describes an incremental mutation.
type ChangeKind byte

const (
	// Upsert inserts the entry or replaces the existing entry at its path.
	Upsert ChangeKind = 'U'
	// Remove deletes the entry at the change's path.
	Remove ChangeKind = 'R'
)

// Change is a single incremental mutation to a Manifest, as reported for
// example by a filesystem watcher.
type Change struct {
	Kind  ChangeKind
	Entry Entry // for Remove, only Path is consulted
}

// Apply returns a new Manifest with the changes applied in order, without
// re-walking the filesystem. The result is exactly what Build would produce
// from the mutated entry set, so its root can be checked against a full
// rebuild.
func (m *Manifest) Apply(changes ...Change) (*Manifest, error) {
	entries := make([]Entry, len(m.Entries))
	copy(entries, m.Entries)
	for _, c := range changes {
		path, err := Canonicalize(c.Entry.Path)
		if err != nil {
			return nil, err
		}
		i, found := entryIndex(entries, path)
		switch c.Kind {
		case Upsert:
			e := c.Entry
			e.Path = path
			switch e.Type {
			case TypeFile, TypeDir, TypeSymlink:
			default:
				return nil, fmt.Errorf("merklefs: unknown entry type %q at %q", e.Type, path)
			}
			if found {
				entries[i] = e
			} else {
				entries = append(entries, Entry{})
				copy(entries[i+1:], entries[i:])
				entries[i] = e
			}
		case Remove:
			if !found {
				return nil, fmt.Errorf("merklefs: cannot remove absent path %q", path)
			}
			entries = append(entries[:i], entries[i+1:]...)
		default:
			return nil, fmt.Errorf("merklefs: unknown change kind %q", c.Kind)
		}
	}
	return Build(entries)
}

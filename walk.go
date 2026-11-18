package formal

import "sort"

// DirInfo describes one directory discovered by Dirs.
type DirInfo struct {
	Path  string
	Usage Usage
}

// Dirs returns every directory in the namespace together with its maintained
// subtree usage. Directories are visited in lexical order.
func (fs *FS) Dirs() []DirInfo {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	var out []DirInfo
	var walk func(string, *directory)
	walk = func(p string, d *directory) {
		out = append(out, DirInfo{Path: p, Usage: d.usage})

		names := make([]string, 0, len(d.entries))
		for name, in := range d.entries {
			if in.kind == kindDir {
				names = append(names, name)
			}
		}
		sort.Strings(names)
		for _, name := range names {
			childPath := "/" + name
			if p != "/" {
				childPath = p + "/" + name
			}
			walk(childPath, d.entries[name].dir)
		}
	}
	walk("/", fs.root)
	return out
}

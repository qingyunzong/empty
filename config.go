package logparse

import "errors"

// ErrAliasCycle is returned when an alias would create a cycle in the
// directed alias graph (including aliasing a key to itself).
var ErrAliasCycle = errors.New("logparse: alias would create a cycle")

// ErrEmptyAlias is returned when either side of an alias is empty.
var ErrEmptyAlias = errors.New("logparse: alias keys must be non-empty")

// Config holds parser configuration: a directed mapping of key aliases.
// Aliases may chain (a->b, b->c resolves a to c); cycles are rejected at
// insertion time. A Config handed to a Parser should be treated as
// immutable; use Clone to derive an updated configuration for hot reload.
type Config struct {
	aliases map[string]string
}

// NewConfig returns an empty configuration.
func NewConfig() *Config {
	return &Config{aliases: make(map[string]string)}
}

// Clone returns a deep copy that can be modified independently.
func (c *Config) Clone() *Config {
	n := &Config{aliases: make(map[string]string, len(c.aliases))}
	for k, v := range c.aliases {
		n.aliases[k] = v
	}
	return n
}

// SetAlias maps key "from" to key "to". Re-pointing an existing alias is
// allowed. It returns ErrAliasCycle if the new edge would close a cycle.
func (c *Config) SetAlias(from, to string) error {
	if from == "" || to == "" {
		return ErrEmptyAlias
	}
	if from == to {
		return ErrAliasCycle
	}
	// Adding from->to closes a cycle iff `from` is reachable from `to`
	// along existing edges.
	for cur := to; ; {
		next, ok := c.aliases[cur]
		if !ok {
			break
		}
		if next == from {
			return ErrAliasCycle
		}
		cur = next
	}
	c.aliases[from] = to
	return nil
}

// RemoveAlias deletes the alias for `from`, if any.
func (c *Config) RemoveAlias(from string) {
	delete(c.aliases, from)
}

// Canonical resolves a key through the alias chain to its final
// canonical key.
func (c *Config) Canonical(key string) string {
	seen := make(map[string]struct{})
	for {
		next, ok := c.aliases[key]
		if !ok {
			return key
		}
		if _, loop := seen[key]; loop {
			// Unreachable while SetAlias rejects cycles; stay safe.
			return key
		}
		seen[key] = struct{}{}
		key = next
	}
}

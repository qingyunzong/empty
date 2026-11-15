package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// CompiledSchema is a parsed schema plus its named-type and registry
// reference closure. It is immutable and safe to share.
type CompiledSchema struct {
	ID          int
	Version     int
	Fingerprint string
	Root        Type
	// Names is the named-type closure: every named type defined by this
	// schema and, transitively, by its references, keyed by fullname.
	Names map[string]Named
	// Refs are the compiled referenced schemas, in declaration order.
	Refs []*CompiledSchema
}

// Lookup returns the named type with the given fullname, or nil.
func (c *CompiledSchema) Lookup(fullname string) Named {
	return c.Names[fullname]
}

// Compiler compiles registry schemas into CompiledSchemas. Compiled schemas
// are cached by content fingerprint: the fingerprint covers the canonical
// schema text and, transitively, the fingerprints of all references, so a
// new version of a referenced schema yields a different cache entry and can
// never mutate or evict previously compiled schemas.
type Compiler struct {
	reg Registry

	mu       sync.Mutex
	cache    map[string]*CompiledSchema
	inflight map[int]bool
}

func NewCompiler(reg Registry) *Compiler {
	return &Compiler{
		reg:      reg,
		cache:    make(map[string]*CompiledSchema),
		inflight: make(map[int]bool),
	}
}

// Compile fetches schema id from the registry, compiles its reference
// closure and returns the compiled schema. Compiling the same content twice
// returns the same *CompiledSchema.
func (c *Compiler) Compile(id int) (*CompiledSchema, error) {
	c.mu.Lock()
	if c.inflight[id] {
		c.mu.Unlock()
		return nil, fmt.Errorf("avro: circular registry reference involving schema id %d", id)
	}
	c.inflight[id] = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.inflight, id)
		c.mu.Unlock()
	}()

	s, err := c.reg.Get(id)
	if err != nil {
		return nil, err
	}

	refs := make([]*CompiledSchema, 0, len(s.References))
	imports := make(map[string]Named)
	for _, ref := range s.References {
		rc, err := c.Compile(ref.ID)
		if err != nil {
			return nil, fmt.Errorf("avro: compiling reference %q (id %d): %w", ref.Name, ref.ID, err)
		}
		refs = append(refs, rc)
		if n, ok := rc.Root.(Named); ok && ref.Name != "" {
			imports[ref.Name] = n
		}
		for n, t := range rc.Names {
			imports[n] = t
		}
	}

	fp := fingerprint(s.Raw, refs)
	c.mu.Lock()
	if hit, ok := c.cache[fp]; ok {
		c.mu.Unlock()
		return hit, nil
	}
	c.mu.Unlock()

	root, names, err := parseSchema(s.Raw, imports)
	if err != nil {
		return nil, fmt.Errorf("avro: compiling schema id %d: %w", id, err)
	}
	cs := &CompiledSchema{
		ID:          s.ID,
		Version:     s.Version,
		Fingerprint: fp,
		Root:        root,
		Names:       names,
		Refs:        refs,
	}
	c.mu.Lock()
	c.cache[fp] = cs
	c.mu.Unlock()
	return cs, nil
}

// fingerprint computes the content fingerprint of a schema: SHA-256 over the
// canonical JSON of the raw schema text and the fingerprints of its
// references, in order. Any change in the closure changes the fingerprint.
func fingerprint(raw string, refs []*CompiledSchema) string {
	canon := raw
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err == nil {
		if b, err := json.Marshal(doc); err == nil {
			canon = string(b)
		}
	}
	h := sha256.New()
	h.Write([]byte(canon))
	for _, r := range refs {
		h.Write([]byte{0})
		h.Write([]byte(r.Fingerprint))
	}
	return hex.EncodeToString(h.Sum(nil))
}

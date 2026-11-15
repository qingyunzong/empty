package dataeng

import (
	"errors"
	"fmt"
	"sync"
)

// ErrSchemaNotFound is returned by a Registry when an id is unknown.
var ErrSchemaNotFound = errors.New("avro: schema not found in registry")

// Reference points from one registry schema to another, Confluent-style:
// Name is the symbol the referring schema uses, ID and Version identify the
// referenced schema.
type Reference struct {
	Name    string
	ID      int
	Version int
}

// Schema is a raw registry entry.
type Schema struct {
	ID         int
	Version    int
	Raw        string
	References []Reference
}

// Registry abstracts a schema registry.
type Registry interface {
	Get(id int) (*Schema, error)
}

// MemoryRegistry is an in-memory Registry, useful for tests and embedding.
type MemoryRegistry struct {
	mu      sync.RWMutex
	schemas map[int]Schema
}

func NewMemoryRegistry() *MemoryRegistry {
	return &MemoryRegistry{schemas: make(map[int]Schema)}
}

// Register stores or replaces the schema for s.ID.
func (m *MemoryRegistry) Register(s Schema) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.schemas[s.ID] = s
}

func (m *MemoryRegistry) Get(id int) (*Schema, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.schemas[id]
	if !ok {
		return nil, fmt.Errorf("%w: id %d", ErrSchemaNotFound, id)
	}
	cp := s
	return &cp, nil
}

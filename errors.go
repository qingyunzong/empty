package dataeng

import "fmt"

func errUnknownNode(id string) error {
	return fmt.Errorf("dataeng: unknown node ID %q", id)
}

func errUnknownEdge(id string) error {
	return fmt.Errorf("dataeng: unknown edge ID %q", id)
}

func errBadEdgeIndex(k int) error {
	return fmt.Errorf("dataeng: de-duplicated edge index %d out of range", k)
}

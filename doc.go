// Package dataeng reads XML fragments from an io.Reader or a byte slice.
//
// Fragment reading is intentionally self-contained: the package never opens
// files, fetches URLs, or otherwise resolves external resources. External
// entities and external DTD subsets are rejected. Only internal general
// entities declared in the document's internal DTD subset are expanded, and
// their combined expanded length is bounded by the caller-provided limit.
//
// Namespaces are resolved with the usual scoping rules. A default namespace
// declaration applies to the element that carries it and to its descendants;
// it is discarded when that element ends and does not leak to later siblings.
// A prefixed name whose prefix is not in scope is an error.
package dataeng

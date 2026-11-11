// Package q194 provides a streaming XML record extractor for document
// collection feeds.
//
// A Reader watches for a configured record element, extracts configured
// attributes and the direct character data of configured direct child
// elements, and emits Start, Field, and either Commit or Abort events for
// every record. Namespace prefixes are resolved against the namespace
// declarations in scope at each element. In accordance with the XML
// Namespaces specification, an unprefixed attribute is in no namespace even
// when the element has a default namespace.
//
// The input is parsed as a stream. Character and entity references may span
// read boundaries. Only the five predefined XML entities (lt, gt, amp, apos,
// and quot) and numeric character references are accepted. Document type
// declarations and other directives are rejected.
package q194

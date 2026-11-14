// Package dataeng interprets telephone numbers without silently turning a
// successful parse into a claim of validity.
//
// A caller supplies one immutable generation of numbering-plan metadata and a
// default region. Interpretations are reported as a set of structurally
// distinct candidates. Each candidate records the international prefix,
// country code, national trunk prefix, national significant number, extension,
// possibility, validity, and the evidence used to reach the interpretation.
//
// Metadata is copied and digested when an Interpreter is created. Results keep
// the version and digest of that snapshot, so changing a later metadata
// generation cannot rewrite an earlier result.
package dataeng

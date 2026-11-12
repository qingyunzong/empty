// Package dataeng provides row-wise boolean operators (AND, OR, XOR) over
// compressed boolean columns made of run-length and packed-literal
// segments. Operators stream over the encoded fragments without expanding
// whole columns, return results normalized into maximal same-value runs,
// and validate both inputs fully (including uint64 length overflow and
// illegal literal tail bits) before producing any output.
package dataeng

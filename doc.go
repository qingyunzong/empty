// Package dataeng provides a streaming map-matching state library for
// location data pipelines. Callers supply candidate road segments,
// transition distances, and observation errors; a bounded Viterbi
// window emits the stable prefix of the best path, late points within
// the watermark may revise the unstable tail, and GPS gaps open new
// segments. All probabilities are computed in the log domain and ties
// resolve deterministically to the lexicographically smallest road ID.
package dataeng

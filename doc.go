package dataeng

// Package dataeng parses cache binary-protocol responses for collection.
// Decoder consumes response bytes incrementally without connecting to a
// cache and splits each body into its extras, key and value regions.

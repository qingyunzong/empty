'use strict';

// Query/event normalization: lowercase, split on anything non-alphanumeric.
function tokenize(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 0);
}

module.exports = { tokenize };

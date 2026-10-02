# Single-key register rules.
rule Register {
  op write(key: string, value: int) -> string;
  op read(key: string) -> int;

  # Two writes to the same key commute (may be reordered past each other).
  commutes(a, b): a.op == op"write" and b.op == op"write" and a.key == b.key;

  # Operations on different keys are declared concurrent: no real-time
  # edge is enforced between them.
  concurrent(a, b): a.key != b.key;

  # Extra causal rule: a read that observes a write's value on the same
  # node happens after that write.
  happens-before(a, b):
    a.op == op"write" and b.op == op"read"
    and a.node == b.node and a.key == b.key and a.value == b.value;
}

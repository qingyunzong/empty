# Read/write register object model.
op write(key: string, value: any) sets key = value
op read(key: string) -> any gets key

rule register {
  # Writes to the same key commute: their relative order is irrelevant.
  commutes write(k, _), write(k, _)

  # A read that observes a write's value happens after that write.
  happens-before write(k, v), read(k) when a.value == b.value and a.value == v
}

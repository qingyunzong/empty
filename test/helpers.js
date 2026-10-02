export const MACHINE_DSL = `
enum ValveState { closed, open }

signal door_closed : input bool = false
signal product_present : input bool = false
signal motor : output bool = false
signal heater : output bool = false
signal fill_valve : output ValveState = closed
signal fill_timer : timer ms = 0ms

invariant not (motor and not door_closed)
invariant not (heater and not door_closed)
invariant not (heater and motor)

device filler {
  signal jammed : input bool = false

  rule stop_motor_on_jam when jammed and motor set motor = false
  rule open_valve_when_ready when door_closed and product_present and fill_timer >= 500ms set fill_valve = open
  rule close_valve_when_empty when not product_present set fill_valve = closed
}
`;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

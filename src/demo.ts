// Demo: drives a two-desk cyclic network with bounded queues into circular
// waiting and prints the reported evidence; then restores a fully wedged
// snapshot and shows the wait persists.
import { Network } from "./model";

const svc = (c: { id: number }) => 1 + ((2 * c.id) % 3);
const network = new Network({
  desks: [
    { id: "A", inputCapacity: 2, outputCapacity: 1, serviceTime: svc },
    { id: "B", inputCapacity: 2, outputCapacity: 2, serviceTime: svc },
  ],
  edges: [
    { from: "A", to: "B" },
    { from: "B", to: "A" },
  ],
  sources: [
    { desk: "A", firstTick: 1, interval: 1, total: 30 },
    { desk: "B", firstTick: 1, interval: 1, total: 30 },
  ],
});

const describe = (net: Network, id: string) => {
  const s = net.deskState(id);
  const slot = s.server
    ? s.server.blocked
      ? `blocked(#${s.server.customer.id})`
      : `busy(#${s.server.customer.id},${s.server.remaining})`
    : "idle";
  return `${id}[in=${s.input.map((c) => c.id)} srv=${slot} out=${s.output.map((c) => c.id)}]`;
};

console.log("part 1: circular wait emerges under load");
let evidence = network.detectCircularWait();
for (let i = 0; i < 50 && !evidence; i++) {
  network.tick();
  evidence = network.detectCircularWait();
  if (network.currentTime <= 6 || evidence) {
    console.log(
      `tick ${network.currentTime}: ${describe(network, "A")}  ${describe(network, "B")}`,
    );
  }
}
if (!evidence) {
  console.log("no circular wait detected");
  process.exitCode = 1;
} else {
  console.log(`\ncircular wait evidence at tick ${network.currentTime}:`);
  console.log(JSON.stringify(evidence, null, 2));
}

console.log("\npart 2: a fully wedged cycle never recovers");
const customer = (id: number) => ({ id, history: [] });
const wedged = Network.fromSnapshot(
  {
    desks: [
      { id: "A", inputCapacity: 2, outputCapacity: 1, serviceTime: 1 },
      { id: "B", inputCapacity: 2, outputCapacity: 2, serviceTime: 1 },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "A" },
    ],
  },
  {
    time: 0,
    nextCustomerId: 10,
    departed: [],
    sources: [],
    desks: {
      A: {
        input: [customer(1), customer(2)],
        server: { customer: customer(3), remaining: 0, blocked: true },
        output: [customer(4)],
      },
      B: {
        input: [customer(5), customer(6)],
        server: { customer: customer(7), remaining: 0, blocked: true },
        output: [customer(8), customer(9)],
      },
    },
  },
);
for (let i = 0; i < 3; i++) {
  wedged.tick();
  const ev = wedged.detectCircularWait();
  console.log(
    `tick ${wedged.currentTime}: ${describe(wedged, "A")}  ${describe(wedged, "B")}  cycle=${ev ? ev.cycle.join("->") : "none"}`,
  );
}

import type { Problem } from "./model.js";

/** Demo instance: 14 jobs, mixed skills, precedence chain, horizon 40. */
export const demo: Problem = {
  horizon: 40,
  jobs: [
    { id: "J1",  duration: 4, skill: "A",    deps: [] },
    { id: "J2",  duration: 3, skill: "B",    deps: [] },
    { id: "J3",  duration: 5, skill: "any",  deps: [] },
    { id: "J4",  duration: 2, skill: "both", deps: ["J1", "J2"] },
    { id: "J5",  duration: 3, skill: "A",    deps: ["J3"] },
    { id: "J6",  duration: 6, skill: "B",    deps: ["J3"] },
    { id: "J7",  duration: 4, skill: "any",  deps: ["J4"] },
    { id: "J8",  duration: 3, skill: "both", deps: ["J5", "J6"] },
    { id: "J9",  duration: 2, skill: "A",    deps: ["J4"] },
    { id: "J10", duration: 5, skill: "B",    deps: ["J7"] },
    { id: "J11", duration: 3, skill: "any",  deps: ["J8"] },
    { id: "J12", duration: 2, skill: "both", deps: ["J9", "J10"] },
    { id: "J13", duration: 4, skill: "A",    deps: ["J11"] },
    { id: "J14", duration: 2, skill: "any",  deps: ["J12", "J13"] },
  ],
};

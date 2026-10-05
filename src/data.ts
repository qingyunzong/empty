import { Problem } from "./types";

// 构建流水线场景：15 个插件（<= 18），含两个"永不可启动"的循环自供反例。
export const problem: Problem = {
  initial: ["git", "node"],
  target: ["release"],
  plugins: [
    { id: "fetcher",      cost: 2, requires: ["git"],                          provides: ["source"] },
    { id: "compiler",     cost: 5, requires: ["source", "node"],               provides: ["ast", "types"] },
    { id: "linter",       cost: 1, requires: ["source"],                       provides: ["lint-report"] },
    { id: "tester",       cost: 3, requires: ["types"],                        provides: ["test-report"] },
    { id: "alt-tester",   cost: 6, requires: ["source"],                       provides: ["test-report"] },
    { id: "optimizer",    cost: 4, requires: ["ast"],                          provides: ["optimized"] },
    { id: "bundler",      cost: 3, requires: ["optimized"],                    provides: ["bundle"] },
    { id: "fast-bundler", cost: 1, requires: ["ast"],                          provides: ["bundle"] },
    { id: "minifier",     cost: 2, requires: ["bundle"],                       provides: ["min-bundle"] },
    { id: "packager",     cost: 3, requires: ["min-bundle", "test-report"],    provides: ["package"] },
    { id: "publisher",    cost: 2, requires: ["package", "lint-report"],       provides: ["release"] },
    { id: "docs-gen",     cost: 2, requires: ["types"],                        provides: ["docs"] },
    // 反例 1：自我供给，requires 只有自己能提供的 bootstrap，永远无法启动。
    { id: "bootstrapper", cost: 1, requires: ["bootstrap"],                    provides: ["bootstrap"] },
    // 反例 2：互相依赖的二元环，双方都无法先启动。
    { id: "cycle-a",      cost: 1, requires: ["cap-b"],                        provides: ["cap-a"] },
    { id: "cycle-b",      cost: 1, requires: ["cap-a"],                        provides: ["cap-b"] },
  ],
};

#include "test_support.hpp"

#include <cstdint>
#include <iostream>
#include <vector>

namespace {

using dlks_formal::DeadlockAnalysis;
using dlks_formal::LockMode;
using dlks_formal::Tick;
using dlks_formal::TransactionId;
using dlks_formal::TransactionProfile;
using dlks_formal::WaitEdge;
using dlks_formal::WaitForGraph;
using dlks_test::check_graph;
using dlks_test::ReferenceGraph;
using dlks_test::require;

ReferenceGraph make_reference(
    const std::map<TransactionId, TransactionProfile>& profiles) {
  ReferenceGraph graph;
  for (const auto& [tx, profile] : profiles) {
    graph.vertices.insert(tx);
    graph.profiles[tx] = profile;
  }
  return graph;
}

void add_to_reference(ReferenceGraph& graph, const WaitEdge& edge) {
  graph.vertices.insert(edge.waiter);
  graph.vertices.insert(edge.holder);
  graph.edges.insert(edge);
}

void remove_from_reference(ReferenceGraph& graph, const WaitEdge& edge) {
  graph.edges.erase(edge);
}

void test_merge_and_split() {
  WaitForGraph graph;
  const std::map<TransactionId, TransactionProfile> profiles{
      {1, {3, 0}}, {2, {2, 0}}, {3, {1, 0}}, {4, {4, 0}}};
  for (const auto& [tx, profile] : profiles) {
    require(graph.add_transaction(tx, profile), "merge/split", "add tx");
  }
  ReferenceGraph reference = make_reference(profiles);

  const std::vector<WaitEdge> initial{
      {1, 2, 100, 1}, {2, 3, 100, 2}, {3, 1, 100, 3},
      {3, 4, 100, 4}};
  for (const WaitEdge& edge : initial) {
    require(graph.add_edge(edge), "merge/split", "add edge");
    add_to_reference(reference, edge);
  }
  check_graph(graph, reference, 50, "merge/split initial");

  // 1,2,3 form a cycle; 4 is only reachable from 3 at this point.
  DeadlockAnalysis analysis = graph.analyze(50);
  require(analysis.cycles.size() == 1, "merge/split", "one SCC cycle");
  require(analysis.cycles.front().members ==
              std::vector<TransactionId>({1, 2, 3}),
          "merge/split", "initial three-vertex cycle");
  require(analysis.cycles.front().victim == 3, "merge/split", "victim 3");

  const WaitEdge close_four{4, 2, 100, 5};
  require(graph.add_edge(close_four), "merge/split", "close four-cycle");
  add_to_reference(reference, close_four);
  check_graph(graph, reference, 50, "merge/split four vertices");
  analysis = graph.analyze(50);
  require(analysis.cycles.front().members ==
              std::vector<TransactionId>({1, 2, 3, 4}),
          "merge/split", "all four vertices merged");

  const WaitEdge break_cycle{3, 1, 100, 3};
  require(graph.remove_edge(break_cycle), "merge/split", "remove edge");
  remove_from_reference(reference, break_cycle);
  check_graph(graph, reference, 50, "merge/split after removal");
  analysis = graph.analyze(50);
  require(analysis.cycles.size() == 1 &&
              analysis.cycles.front().members ==
                  std::vector<TransactionId>({2, 3, 4}),
          "merge/split", "old component split into a residual cycle");

  const WaitEdge break_residual{4, 2, 100, 5};
  require(graph.remove_edge(break_residual), "merge/split",
          "remove residual edge");
  remove_from_reference(reference, break_residual);
  check_graph(graph, reference, 50, "merge/split no cycles");
  require(graph.analyze(50).cycles.empty(), "merge/split",
          "all cycles removed");

  require(graph.add_edge(break_cycle), "merge/split", "restore edge");
  add_to_reference(reference, break_cycle);
  check_graph(graph, reference, 50, "merge/split restored");
}

void test_parallel_edges() {
  WaitForGraph graph;
  const std::map<TransactionId, TransactionProfile> profiles{
      {1, {1, 0}}, {2, {2, 0}}};
  for (const auto& [tx, profile] : profiles) {
    require(graph.add_transaction(tx, profile), "parallel", "add tx");
  }
  ReferenceGraph reference = make_reference(profiles);

  const WaitEdge first{1, 2, 10, 1};
  const WaitEdge second{1, 2, 11, 2};
  const WaitEdge back{2, 1, 12, 3};
  for (const WaitEdge& edge : {first, second, back}) {
    require(graph.add_edge(edge), "parallel", "add edge");
    add_to_reference(reference, edge);
  }
  check_graph(graph, reference, 0, "parallel three edges");
  require(graph.analyze(0).cycles.size() == 1, "parallel", "cycle present");

  require(graph.remove_edge(first), "parallel", "remove first");
  remove_from_reference(reference, first);
  check_graph(graph, reference, 0, "parallel after one removal");
  require(graph.analyze(0).cycles.size() == 1, "parallel",
          "second edge preserves cycle");

  require(graph.remove_edge(second), "parallel", "remove second");
  remove_from_reference(reference, second);
  check_graph(graph, reference, 0, "parallel after both removals");
  require(graph.analyze(0).cycles.empty(), "parallel",
          "cycle disappeared after last parallel edge");
}

void test_self_loop() {
  WaitForGraph graph;
  graph.add_transaction(7, {4, 0});
  ReferenceGraph reference;
  reference.vertices.insert(7);
  reference.profiles[7] = {4, 0};
  const WaitEdge loop{7, 7, 1, 1};
  require(graph.add_edge(loop), "self-loop", "add loop");
  add_to_reference(reference, loop);
  check_graph(graph, reference, 10, "self-loop present");
  const DeadlockAnalysis analysis = graph.analyze(10);
  require(analysis.cycles.size() == 1 &&
              analysis.cycles.front().members ==
                  std::vector<TransactionId>({7}) &&
              analysis.cycles.front().victim == 7,
          "self-loop", "self-loop is a cycle with itself as victim");

  require(graph.remove_edge(loop), "self-loop", "remove loop");
  remove_from_reference(reference, loop);
  check_graph(graph, reference, 10, "self-loop removed");
  require(graph.analyze(10).cycles.empty(), "self-loop", "no cycle");
}

void test_victim_order() {
  WaitForGraph graph;
  const std::map<TransactionId, TransactionProfile> profiles{
      {1, {5, 0}}, {2, {1, 50}}, {3, {1, 0}}, {4, {2, 0}}};
  for (const auto& [tx, profile] : profiles) {
    graph.add_transaction(tx, profile);
  }
  ReferenceGraph reference = make_reference(profiles);
  const std::vector<WaitEdge> edges{
      {1, 2, 1, 1}, {2, 3, 1, 2}, {3, 4, 1, 3}, {4, 1, 1, 4}};
  for (const WaitEdge& edge : edges) {
    graph.add_edge(edge);
    add_to_reference(reference, edge);
  }
  check_graph(graph, reference, 100, "victim cost/age");
  require(graph.analyze(100).cycles.front().victim == 3, "victim order",
          "cost tie picks oldest, then id");

  for (const TransactionId tx : {1, 2, 3, 4}) {
    graph.set_profile(tx, {1, 0});
    reference.profiles[tx] = {1, 0};
  }
  check_graph(graph, reference, 100, "victim id tie");
  require(graph.analyze(100).cycles.front().victim == 1, "victim order",
          "complete tie picks lowest id");
}

void test_remove_transaction() {
  WaitForGraph graph;
  const std::map<TransactionId, TransactionProfile> profiles{
      {1, {1, 0}}, {2, {2, 0}}, {3, {3, 0}}};
  for (const auto& [tx, profile] : profiles) {
    graph.add_transaction(tx, profile);
  }
  ReferenceGraph reference = make_reference(profiles);
  const std::vector<WaitEdge> edges{
      {1, 2, 1, 1}, {2, 3, 1, 2}, {3, 1, 1, 3}};
  for (const WaitEdge& edge : edges) {
    graph.add_edge(edge);
    add_to_reference(reference, edge);
  }
  check_graph(graph, reference, 0, "remove tx before");

  require(graph.remove_transaction(2), "remove tx", "remove");
  reference.vertices.erase(2);
  reference.profiles.erase(2);
  for (const WaitEdge& edge : edges) {
    if (edge.waiter == 2 || edge.holder == 2) {
      reference.edges.erase(edge);
    }
  }
  check_graph(graph, reference, 0, "remove tx after");
  require(graph.analyze(0).cycles.empty(), "remove tx", "cycle broken");

  require(graph.add_transaction(2, {2, 0}), "remove tx", "re-add");
  reference.vertices.insert(2);
  reference.profiles[2] = {2, 0};
  for (const WaitEdge& edge : edges) {
    graph.add_edge(edge);
    add_to_reference(reference, edge);
  }
  check_graph(graph, reference, 0, "remove tx re-added");
}

void test_batch_delta() {
  WaitForGraph graph;
  const std::map<TransactionId, TransactionProfile> profiles{
      {1, {1, 0}}, {2, {2, 0}}, {3, {3, 0}}, {4, {4, 0}}};
  for (const auto& [tx, profile] : profiles) {
    graph.add_transaction(tx, profile);
  }
  ReferenceGraph reference = make_reference(profiles);
  for (const WaitEdge& edge :
       std::vector<WaitEdge>{{1, 2, 1, 1}, {2, 3, 1, 2}, {3, 1, 1, 3}}) {
    graph.add_edge(edge);
    add_to_reference(reference, edge);
  }

  const std::vector<WaitEdge> removals{{3, 1, 1, 3}};
  const std::vector<WaitEdge> additions{{3, 4, 1, 4}, {4, 1, 1, 5}};
  graph.apply_delta(removals, additions);
  for (const WaitEdge& edge : removals) {
    remove_from_reference(reference, edge);
  }
  for (const WaitEdge& edge : additions) {
    add_to_reference(reference, edge);
  }
  check_graph(graph, reference, 0, "batch replace");
  require(graph.analyze(0).cycles.front().members ==
              std::vector<TransactionId>({1, 2, 3, 4}),
          "batch", "new four-node cycle");

  // The same edge in both lists must remain present.
  graph.apply_delta({{1, 2, 1, 1}}, {{1, 2, 1, 1}});
  check_graph(graph, reference, 0, "batch remove+add same edge");
}

void test_invalid_edges() {
  WaitForGraph graph;
  graph.add_transaction(1, {1, 0});
  bool threw = false;
  try {
    graph.add_edge({1, 99, 1, 1});
  } catch (const std::out_of_range&) {
    threw = true;
  }
  require(threw, "invalid edge", "unknown endpoint throws");
  require(graph.add_edge({1, 1, 1, 1}), "invalid edge",
          "self edge accepted");
  require(graph.remove_edge({1, 1, 1, 1}), "invalid edge",
          "self edge removable");
  require(!graph.remove_edge({1, 1, 1, 1}), "invalid edge",
          "second removal is a no-op");
}

}  // namespace

int main() {
  try {
    test_merge_and_split();
    test_parallel_edges();
    test_self_loop();
    test_victim_order();
    test_remove_transaction();
    test_batch_delta();
    test_invalid_edges();
  } catch (const std::exception& error) {
    std::cerr << "FAILED: " << error.what() << "\n";
    return 1;
  }
  std::cout << "wait_for_graph tests passed\n";
  return 0;
}

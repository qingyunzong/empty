#include "test_support.hpp"

#include <cstdint>
#include <iostream>
#include <vector>

namespace {

using dlks_formal::DeadlockAnalysis;
using dlks_formal::LockManager;
using dlks_formal::LockMode;
using dlks_formal::PendingRequest;
using dlks_formal::RequestId;
using dlks_formal::TransactionId;
using dlks_formal::WaitEdge;
using dlks_test::check_manager;
using dlks_test::require;

constexpr dlks_formal::ResourceId kR0 = 10;
constexpr dlks_formal::ResourceId kR1 = 20;

WaitEdge edge(TransactionId waiter, TransactionId holder,
              dlks_formal::ResourceId resource, RequestId request) {
  return WaitEdge{waiter, holder, resource, request};
}

void test_multi_holder_upgrade_deadlock() {
  LockManager manager;
  require(manager.begin(1, 5), "upgrade deadlock", "begin 1");
  require(manager.begin(2, 1), "upgrade deadlock", "begin 2");
  require(manager.acquire(1, kR0, LockMode::shared).granted,
          "upgrade deadlock", "1 holds S");
  require(manager.acquire(2, kR0, LockMode::shared).granted,
          "upgrade deadlock", "2 holds S");
  require(manager.acquire(1, kR1, LockMode::shared).granted,
          "upgrade deadlock", "1 holds second S");

  const auto upgrade = manager.acquire(1, kR0, LockMode::exclusive);
  require(!upgrade.granted, "upgrade deadlock", "upgrade waits");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(1, 2, kR0, upgrade.id)}),
          "upgrade deadlock", "upgrade waits only for the other S holder");

  const auto second = manager.acquire(2, kR1, LockMode::exclusive);
  require(!second.granted, "upgrade deadlock", "2 waits on R1");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(1, 2, kR0, upgrade.id),
                                  edge(2, 1, kR1, second.id)}),
          "upgrade deadlock", "two-cycle edges");
  check_manager(manager, "upgrade deadlock formed");

  const DeadlockAnalysis analysis = manager.deadlock_analysis();
  require(analysis.cycles.size() == 1 &&
              analysis.cycles.front().members ==
                  std::vector<TransactionId>({1, 2}) &&
              analysis.cycles.front().victim == 2,
          "upgrade deadlock", "cheapest transaction is victim");

  const std::vector<TransactionId> aborted = manager.resolve_deadlocks();
  require(aborted == std::vector<TransactionId>({2}), "upgrade deadlock",
          "abort victim 2");
  require(!manager.contains(2), "upgrade deadlock", "2 removed");
  require(manager.graph().edge_count() == 0, "upgrade deadlock",
          "edges removed atomically");
  require(manager.holders(kR0).at(1) == LockMode::exclusive,
          "upgrade deadlock", "upgrade granted after abort");
  require(manager.holders(kR1).at(1) == LockMode::shared,
          "upgrade deadlock", "other lock retained");
  check_manager(manager, "upgrade deadlock resolved");
}

void test_release_pumps_grants_atomically() {
  LockManager manager;
  manager.begin(1, 1);
  manager.begin(2, 2);
  manager.begin(3, 3);
  manager.acquire(1, kR0, LockMode::shared);
  const auto writer = manager.acquire(2, kR0, LockMode::exclusive);
  const auto shared = manager.acquire(3, kR0, LockMode::shared);
  require(!writer.granted && !shared.granted, "release pump",
          "both wait");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(2, 1, kR0, writer.id)}),
          "release pump",
          "the shared request is FIFO-blocked but not holder-blocked");
  check_manager(manager, "release pump before");

  require(manager.release(1, kR0), "release pump", "release");
  require(manager.holders(kR0).at(2) == LockMode::exclusive,
          "release pump", "writer granted");
  require(manager.pending_for(3).has_value(), "release pump",
          "shared request remains queued behind writer");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(3, 2, kR0, shared.id)}),
          "release pump", "grant removed one edge and added the new block");
  check_manager(manager, "release pump after first grant");

  require(manager.release(2, kR0), "release pump", "release writer");
  require(manager.holders(kR0).at(3) == LockMode::shared, "release pump",
          "shared request granted");
  require(manager.graph().edge_count() == 0, "release pump",
          "all wait-for edges removed");
  check_manager(manager, "release pump finished");
}

void test_cancel_timeout_and_upgrade_cancel() {
  LockManager manager;
  manager.begin(1, 1);
  manager.begin(2, 2);
  manager.begin(3, 3);
  manager.acquire(1, kR0, LockMode::exclusive);
  const auto second = manager.acquire(2, kR0, LockMode::shared);
  const auto third = manager.acquire(3, kR0, LockMode::shared);
  require(manager.graph().edge_count() == 2, "cancel/timeout",
          "two queued edges");

  require(manager.cancel(second.id), "cancel/timeout", "cancel second");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(3, 1, kR0, third.id)}),
          "cancel/timeout", "cancel removed exactly one edge");
  check_manager(manager, "cancel/timeout after cancel");

  require(manager.timeout(third.id), "cancel/timeout", "timeout third");
  require(manager.graph().edge_count() == 0, "cancel/timeout",
          "timeout removed last edge");
  check_manager(manager, "cancel/timeout after timeout");

  manager.begin(4, 4);
  manager.begin(5, 5);
  manager.acquire(4, kR1, LockMode::shared);
  manager.acquire(5, kR1, LockMode::shared);
  const auto upgrade = manager.acquire(4, kR1, LockMode::exclusive);
  require(manager.pending(upgrade.id).has_value() &&
              manager.pending(upgrade.id)->kind ==
                  dlks_formal::RequestKind::upgrade,
          "cancel/timeout", "classified as upgrade");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(4, 5, kR1, upgrade.id)}),
          "cancel/timeout", "upgrade edge");
  require(manager.cancel_pending(4), "cancel/timeout",
          "cancel upgrade");
  require(manager.holders(kR1).at(4) == LockMode::shared,
          "cancel/timeout", "currently-held S survives cancellation");
  require(manager.graph().edge_count() == 0, "cancel/timeout",
          "upgrade edge removed");
  check_manager(manager, "cancel/timeout upgrade canceled");
}

void test_timeout_wave() {
  LockManager manager;
  manager.begin(1, 1);
  manager.begin(2, 2);
  manager.begin(3, 3);
  manager.acquire(1, kR0, LockMode::exclusive);
  const auto second = manager.acquire(2, kR0, LockMode::shared, 2);
  const auto third = manager.acquire(3, kR0, LockMode::shared, 2);
  require(manager.graph().edge_count() == 2, "timeout wave",
          "two waits");

  const std::vector<RequestId> none = manager.advance_time(1);
  require(none.empty(), "timeout wave", "nothing expired at tick 1");
  require(manager.graph().edge_count() == 2, "timeout wave",
          "edges still present");
  check_manager(manager, "timeout wave tick 1");

  const std::vector<RequestId> expired = manager.advance_to(2);
  require(expired == std::vector<RequestId>({second.id, third.id}),
          "timeout wave", "both requests expired in order");
  require(manager.pending_requests().empty(), "timeout wave",
          "pending queue empty");
  require(manager.graph().edge_count() == 0, "timeout wave",
          "all edges removed by the timeout wave");
  check_manager(manager, "timeout wave expired");

  LockManager manager2;
  manager2.begin(1, 1);
  manager2.begin(2, 2);
  manager2.begin(3, 3);
  manager2.acquire(1, kR0, LockMode::shared);
  const auto expiring = manager2.acquire(2, kR0, LockMode::exclusive, 1);
  const auto persistent = manager2.acquire(3, kR0, LockMode::exclusive);
  require(manager2.graph().edges() ==
              std::set<WaitEdge>({edge(2, 1, kR0, expiring.id),
                                  edge(3, 1, kR0, persistent.id)}),
          "timeout wave", "both blocked by S holder");
  const std::vector<RequestId> wave = manager2.advance_time(1);
  require(wave == std::vector<RequestId>({expiring.id}), "timeout wave",
          "only the expiring request timed out");
  require(manager2.graph().edges() ==
              std::set<WaitEdge>({edge(3, 1, kR0, persistent.id)}),
          "timeout wave", "expiry is applied before any grant");
  require(manager2.pending_for(3).has_value(), "timeout wave",
          "persistent request stays queued behind the S holder");
  check_manager(manager2, "timeout wave selective");

  LockManager manager3;
  manager3.begin(1, 1);
  manager3.begin(2, 2);
  manager3.begin(3, 3);
  manager3.acquire(1, kR0, LockMode::shared);
  const auto expired_head = manager3.acquire(2, kR0, LockMode::exclusive, 1);
  const auto trailing_reader =
      manager3.acquire(3, kR0, LockMode::shared);
  require(manager3.queue(kR0) ==
              std::vector<RequestId>({expired_head.id, trailing_reader.id}),
          "timeout wave", "expiring writer is FIFO head");
  require(manager3.graph().edges() ==
              std::set<WaitEdge>({edge(2, 1, kR0, expired_head.id)}),
          "timeout wave", "only the writer is holder-blocked");
  const std::vector<RequestId> head_wave = manager3.advance_time(1);
  require(head_wave == std::vector<RequestId>({expired_head.id}),
          "timeout wave", "head expired");
  require(manager3.holders(kR0).at(3) == LockMode::shared, "timeout wave",
          "trailing reader granted after the timeout");
  require(manager3.graph().edge_count() == 0, "timeout wave",
          "timeout and grant leave no edges");
  check_manager(manager3, "timeout wave head pump");
}

void test_end_transaction_releases_and_pumps() {
  LockManager manager;
  manager.begin(1, 1);
  manager.begin(2, 2);
  manager.begin(3, 3);
  manager.acquire(1, kR0, LockMode::exclusive);
  const auto second = manager.acquire(2, kR0, LockMode::shared);
  const auto third = manager.acquire(3, kR0, LockMode::shared);
  require(manager.graph().edge_count() == 2, "end transaction",
          "two waits");

  require(manager.end_transaction(1), "end transaction", "end 1");
  require(!manager.contains(1), "end transaction", "transaction gone");
  require(!manager.graph().has_transaction(1), "end transaction",
          "graph vertex gone");
  require(manager.holders(kR0).at(2) == LockMode::shared &&
              manager.holders(kR0).at(3) == LockMode::shared,
          "end transaction", "both shared requests granted");
  require(manager.graph().edge_count() == 0, "end transaction",
          "wait-for edges removed");
  require(manager.queue(kR0).empty(), "end transaction", "queue empty");
  (void)second;
  (void)third;
  check_manager(manager, "end transaction");
}

void test_end_pending_repumps_dependent_edges() {
  LockManager manager;
  for (const TransactionId tx : {1, 2, 3, 4, 5}) {
    manager.begin(tx, tx);
  }
  manager.acquire(2, kR0, LockMode::shared);
  const auto head = manager.acquire(1, kR0, LockMode::exclusive);
  const auto reader = manager.acquire(3, kR0, LockMode::shared);
  const auto writer = manager.acquire(4, kR0, LockMode::exclusive);
  const auto trailing = manager.acquire(5, kR0, LockMode::shared);
  require(manager.queue(kR0) ==
              std::vector<RequestId>({head.id, reader.id, writer.id,
                                      trailing.id}),
          "end pending", "FIFO order");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(1, 2, kR0, head.id),
                                  edge(4, 2, kR0, writer.id)}),
          "end pending", "only currently conflicting waits have edges");

  // Removing the head grants the shared request; the writer's edge set must
  // gain the new shared holder in the same atomic step.
  require(manager.end_transaction(1), "end pending", "end head");
  require(manager.holders(kR0).at(3) == LockMode::shared, "end pending",
          "reader granted");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(4, 2, kR0, writer.id),
                                  edge(4, 3, kR0, writer.id)}),
          "end pending", "dependent writer edges refreshed");
  require(manager.pending_for(5).has_value(), "end pending",
          "trailing reader remains behind writer");
  check_manager(manager, "end pending after head removal");

  require(manager.end_transaction(2), "end pending", "end holder");
  require(manager.pending_for(4).has_value(), "end pending",
          "writer still blocked by the granted reader");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(4, 3, kR0, writer.id)}),
          "end pending", "one holder edge removed, the other remains");
  check_manager(manager, "end pending after first holder removal");

  require(manager.end_transaction(3), "end pending", "end second holder");
  require(manager.holders(kR0).at(4) == LockMode::exclusive, "end pending",
          "writer granted");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(5, 4, kR0, trailing.id)}),
          "end pending", "trailing reader waits for writer");
  check_manager(manager, "end pending after all holders removed");
}

void test_release_all_across_resources() {
  LockManager manager;
  manager.begin(1, 1);
  manager.begin(2, 2);
  manager.begin(3, 3);
  manager.acquire(1, kR0, LockMode::shared);
  manager.acquire(1, kR1, LockMode::shared);
  const auto first_writer = manager.acquire(2, kR0, LockMode::exclusive);
  const auto second_writer = manager.acquire(3, kR1, LockMode::exclusive);
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(2, 1, kR0, first_writer.id),
                                  edge(3, 1, kR1, second_writer.id)}),
          "release all", "two resources wait on the same holder");
  check_manager(manager, "release all before");

  require(manager.release_all(1), "release all", "release both");
  require(manager.holders(kR0).at(2) == LockMode::exclusive &&
              manager.holders(kR1).at(3) == LockMode::exclusive,
          "release all", "both writers granted in one step");
  require(manager.graph().edge_count() == 0, "release all",
          "all cross-resource edges removed");
  check_manager(manager, "release all after");
}

void test_victim_age_tie() {
  LockManager manager;
  manager.begin(1, 1);
  manager.advance_time(5);
  manager.begin(2, 1);
  require(manager.transaction_profile(1)->born == 0, "age victim",
          "tx 1 born at zero");
  require(manager.transaction_profile(2)->born == 5, "age victim",
          "tx 2 born at five");

  manager.acquire(1, kR0, LockMode::shared);
  manager.acquire(2, kR0, LockMode::shared);
  manager.acquire(1, kR1, LockMode::shared);
  manager.acquire(1, kR0, LockMode::exclusive);
  manager.acquire(2, kR1, LockMode::exclusive);
  check_manager(manager, "age victim formed");

  const DeadlockAnalysis analysis = manager.deadlock_analysis();
  require(analysis.cycles.size() == 1, "age victim", "one cycle");
  require(analysis.cycles.front().victim == 1, "age victim",
          "older transaction wins an equal-cost tie");
  require(manager.resolve_deadlocks() ==
              std::vector<TransactionId>({1}),
          "age victim", "older transaction aborted");
  check_manager(manager, "age victim resolved");
}

void test_three_way_upgrade_cycle() {
  LockManager manager;
  manager.begin(1, 3);
  manager.begin(2, 1);
  manager.begin(3, 2);
  for (const TransactionId tx : {1, 2, 3}) {
    manager.acquire(tx, kR0, LockMode::shared);
  }
  for (const TransactionId tx : {1, 2, 3}) {
    const auto upgrade = manager.acquire(tx, kR0, LockMode::exclusive);
    require(!upgrade.granted, "three-way", "upgrade waits");
  }
  check_manager(manager, "three-way cycle formed");
  const DeadlockAnalysis analysis = manager.deadlock_analysis();
  require(analysis.cycles.size() == 1 &&
              analysis.cycles.front().members ==
                  std::vector<TransactionId>({1, 2, 3}) &&
              analysis.cycles.front().victim == 2,
          "three-way", "one SCC and cheapest victim");

  const std::vector<TransactionId> aborted = manager.resolve_deadlocks();
  require(aborted == std::vector<TransactionId>({2, 3}), "three-way",
          "victims selected pass by pass");
  require(manager.holders(kR0).at(1) == LockMode::exclusive,
          "three-way", "survivor upgraded");
  require(manager.graph().edge_count() == 0, "three-way",
          "all edges removed");
  check_manager(manager, "three-way resolved");
}

void test_fifo_and_grants() {
  LockManager manager;
  manager.begin(1, 1);
  manager.begin(2, 2);
  manager.begin(3, 3);
  manager.acquire(1, kR0, LockMode::shared);
  const auto writer = manager.acquire(2, kR0, LockMode::exclusive);
  const auto reader = manager.acquire(3, kR0, LockMode::shared);
  require(manager.queue(kR0) ==
              std::vector<RequestId>({writer.id, reader.id}),
          "fifo", "writer is ahead of reader");

  // Administrative grant may pick any compatible pending request, even one
  // behind an incompatible queue head.
  require(manager.grant(reader.id), "fifo",
          "reader is compatible and can be granted explicitly");
  require(manager.holders(kR0).at(3) == LockMode::shared, "fifo",
          "reader holds shared");
  require(manager.pending_for(2).has_value(), "fifo",
          "writer remains queued");
  require(manager.graph().edges() ==
              std::set<WaitEdge>({edge(2, 1, kR0, writer.id),
                                  edge(2, 3, kR0, writer.id)}),
          "fifo", "writer now waits for both readers");
  check_manager(manager, "fifo after explicit grant");

  require(!manager.grant(writer.id), "fifo",
          "writer is not compatible while readers hold");
  require(manager.release(1, kR0), "fifo", "release first reader");
  require(manager.pending_for(2).has_value(), "fifo",
          "writer still blocked by second reader");
  require(manager.release(3, kR0), "fifo", "release second reader");
  require(manager.holders(kR0).at(2) == LockMode::exclusive, "fifo",
          "writer granted after both readers leave");
  require(manager.graph().edge_count() == 0, "fifo",
          "no wait-for edges remain");
  check_manager(manager, "fifo after releases");
}

}  // namespace

int main() {
  try {
    test_multi_holder_upgrade_deadlock();
    test_release_pumps_grants_atomically();
    test_cancel_timeout_and_upgrade_cancel();
    test_timeout_wave();
    test_end_transaction_releases_and_pumps();
    test_end_pending_repumps_dependent_edges();
    test_release_all_across_resources();
    test_victim_age_tie();
    test_three_way_upgrade_cycle();
    test_fifo_and_grants();
  } catch (const std::exception& error) {
    std::cerr << "FAILED: " << error.what() << "\n";
    return 1;
  }
  std::cout << "lock_manager tests passed\n";
  return 0;
}

cmake_minimum_required(VERSION 3.20)
project(lockwait_diag LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_library(lockwait src/model.cpp)
target_include_directories(lockwait PUBLIC src)
target_compile_options(lockwait PRIVATE -Wall -Wextra -Wpedantic)

add_executable(lockwait-diag src/main.cpp)
target_link_libraries(lockwait-diag PRIVATE lockwait)
target_compile_options(lockwait-diag PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(lockwait_tests tests/test_main.cpp)
target_link_libraries(lockwait_tests PRIVATE lockwait)
target_compile_options(lockwait_tests PRIVATE -Wall -Wextra -Wpedantic)

set(LOCKWAIT_SCENARIOS
  basic_xy_deadlock
  shared_vs_exclusive_blocking
  shared_wait_blocked_by_exclusive
  upgrade_deadlock
  unfinished_call_not_holder
  release_breaks_cycle
  shortest_cycle_wins
  multi_lock_holder
  cancel_removes_waiter
  per_moment_verification
  semantic_errors
)

foreach(scenario IN LISTS LOCKWAIT_SCENARIOS)
  add_test(NAME ${scenario} COMMAND lockwait_tests ${scenario})
endforeach()

# End-to-end CLI test: the sample log must report the T1<->T2 deadlock.
add_test(NAME cli_sample_log
  COMMAND lockwait-diag ${CMAKE_CURRENT_SOURCE_DIR}/examples/deadlock.log)
set_tests_properties(cli_sample_log PROPERTIES
  PASS_REGULAR_EXPRESSION "DEADLOCK first detected at event #6")

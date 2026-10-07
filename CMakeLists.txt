cmake_minimum_required(VERSION 3.20)
project(traffic_sim CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(traffic_sim src/traffic_sim.cpp)
target_include_directories(traffic_sim PUBLIC src)
target_compile_options(traffic_sim PRIVATE -Wall -Wextra -Wpedantic)

add_executable(traffic_sim_demo src/main.cpp)
target_link_libraries(traffic_sim_demo PRIVATE traffic_sim)

enable_testing()

add_executable(traffic_sim_tests tests/traffic_sim_tests.cpp)
target_link_libraries(traffic_sim_tests PRIVATE traffic_sim)

set(TRAFFIC_SIM_TEST_CASES
    no_conflict_both_pass
    id_tiebreak_and_reason
    waiting_time_priority
    emergency_priority_only
    swap_conflict
    follow_conflict
    waiting_accumulates_and_resets
    verify_helpers
    full_run_reference)

foreach(case IN LISTS TRAFFIC_SIM_TEST_CASES)
  add_test(NAME ${case} COMMAND traffic_sim_tests ${case})
endforeach()

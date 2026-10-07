cmake_minimum_required(VERSION 3.20)
project(traffic_sim LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(trafficsim src/simulator.cpp)
target_include_directories(trafficsim PUBLIC include)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(trafficsim PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(traffic_demo src/main.cpp)
target_link_libraries(traffic_demo PRIVATE trafficsim)

enable_testing()
add_executable(sim_tests tests/test_simulator.cpp)
target_link_libraries(sim_tests PRIVATE trafficsim)

set(SIM_TEST_CASES
    priority_wait_then_id
    emergency_boosts_priority
    emergency_not_exempt_from_conflict
    conflict_rejection_reason
    occupied_target_blocks_even_if_vacated
    head_on_swap_blocked
    wait_accumulation
    arrival_and_done
    randomized_no_collision_and_wait_check
    invalid_input_rejected
)
foreach(case IN LISTS SIM_TEST_CASES)
    add_test(NAME ${case} COMMAND sim_tests ${case})
endforeach()

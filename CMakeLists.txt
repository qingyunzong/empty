cmake_minimum_required(VERSION 3.20)
project(gatesim LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(gatesim src/gatesim.cpp)
target_include_directories(gatesim PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_options(gatesim PRIVATE -Wall -Wextra -Wpedantic)

add_executable(gatesim_demo src/main.cpp)
target_link_libraries(gatesim_demo PRIVATE gatesim)

enable_testing()
add_executable(gatesim_tests tests/test_gatesim.cpp)
target_link_libraries(gatesim_tests PRIVATE gatesim)
target_compile_options(gatesim_tests PRIVATE -Wall -Wextra -Wpedantic)

set(GATESIM_TESTS
    inertial_cancel
    stale_event
    zero_delay_delta
    same_tick_order
    pulse_exactly_delay
    xor_same_tick
    delta_loop)
foreach(name IN LISTS GATESIM_TESTS)
    add_test(NAME ${name} COMMAND gatesim_tests ${name})
endforeach()

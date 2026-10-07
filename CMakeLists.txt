cmake_minimum_required(VERSION 3.20)
project(graph_intersect LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(graph_intersect INTERFACE)
target_include_directories(graph_intersect INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_executable(test_intersect tests/test_intersect.cpp)
target_link_libraries(test_intersect PRIVATE graph_intersect)
target_compile_options(test_intersect PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_test(NAME basic COMMAND test_intersect basic)
add_test(NAME randomized_vs_reference COMMAND test_intersect randomized)
add_test(NAME cursor_error COMMAND test_intersect cursor_error)
add_test(NAME unsorted_input COMMAND test_intersect unsorted)
add_test(NAME memory_budget COMMAND test_intersect budget)
add_test(NAME lazy_streaming COMMAND test_intersect lazy)
add_test(NAME edge_cases COMMAND test_intersect edge_cases)
add_test(NAME graph_integration COMMAND test_intersect graph)

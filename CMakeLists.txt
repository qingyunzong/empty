cmake_minimum_required(VERSION 3.20)
project(graph_adjacency_intersection LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(graph_adjacency src/adjacency_intersection.cpp)
target_include_directories(graph_adjacency PUBLIC include)
target_compile_options(graph_adjacency PRIVATE -Wall -Wextra -Wpedantic)

include(CTest)
if(BUILD_TESTING)
    add_executable(adjacency_intersection_test
        tests/adjacency_intersection_test.cpp)
    target_link_libraries(adjacency_intersection_test PRIVATE graph_adjacency)
    target_compile_options(adjacency_intersection_test PRIVATE
        -Wall -Wextra -Wpedantic)

    set(ADJACENCY_TESTS
        basic_intersection
        duplicates_unique_output
        cursor_error_publishes_nothing
        error_at_first_element
        budget_exceeded
        resident_ids_bounded_on_large_input
        unsorted_input_detected
        empty_and_single_inputs
        fuzz_against_reference)
    foreach(test_name IN LISTS ADJACENCY_TESTS)
        add_test(NAME ${test_name}
            COMMAND adjacency_intersection_test ${test_name})
    endforeach()
endif()

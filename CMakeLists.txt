cmake_minimum_required(VERSION 3.20)
project(geom_tool LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(rect_union src/rect_union.cpp)
target_include_directories(rect_union PUBLIC include)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(rect_union PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(geom_tool src/main.cpp)
target_link_libraries(geom_tool PRIVATE rect_union)

enable_testing()
add_executable(rect_union_tests tests/rect_union_tests.cpp)
target_link_libraries(rect_union_tests PRIVATE rect_union)

set(RECT_UNION_TESTS
    single_rectangle
    zero_area_ignored
    unnormalized_coordinates
    overlap
    edge_touching_merges
    partial_edge_touching
    corner_touching_does_not_merge
    containment
    remove_restores
    replace_same_id
    large_coordinates
    negative_coordinates
    randomized_vs_unit_grid_model
)
foreach(test_name IN LISTS RECT_UNION_TESTS)
    add_test(NAME ${test_name}
             COMMAND rect_union_tests ${test_name})
endforeach()

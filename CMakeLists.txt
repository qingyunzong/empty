cmake_minimum_required(VERSION 3.20)
project(intmesh LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(mesh src/mesh.cpp)
target_include_directories(mesh PUBLIC include)
target_compile_options(mesh PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(mesh_tests tests/mesh_tests.cpp)
target_link_libraries(mesh_tests PRIVATE mesh)
target_compile_options(mesh_tests PRIVATE -Wall -Wextra -Wpedantic)

foreach(case IN ITEMS
    duplicate_edges
    zero_area
    normal_aggregation
    incremental_move
    snapshot_lifetime)
  add_test(NAME ${case} COMMAND mesh_tests ${case})
endforeach()

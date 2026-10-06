cmake_minimum_required(VERSION 3.16)
project(ray_triangle_rational CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(geom src/intersect.cpp)
target_include_directories(geom PUBLIC include)
target_compile_options(geom PRIVATE -Wall -Wextra)

enable_testing()

add_executable(test_intersect tests/test_intersect.cpp)
target_link_libraries(test_intersect PRIVATE geom)

add_test(NAME intersect COMMAND test_intersect)

cmake_minimum_required(VERSION 3.16)
project(rational_geometry LANGUAGES CXX)

add_library(geom INTERFACE)
target_include_directories(geom INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(geom INTERFACE cxx_std_20)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(geom INTERFACE -Wall -Wextra)
endif()

enable_testing()
add_executable(ray_triangle_tests tests/ray_triangle_tests.cpp)
target_link_libraries(ray_triangle_tests PRIVATE geom)
add_test(NAME ray_triangle_tests COMMAND ray_triangle_tests)

cmake_minimum_required(VERSION 3.16)
project(dlks_q257 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
enable_testing()

add_library(tc_compositor STATIC src/compositor.cpp)
target_include_directories(tc_compositor PUBLIC include)
target_compile_options(tc_compositor PRIVATE -Wall -Wextra -Wpedantic)

add_executable(compositor_tests tests/test_compositor.cpp)
target_link_libraries(compositor_tests PRIVATE tc_compositor)
target_compile_options(compositor_tests PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME compositor_tests COMMAND compositor_tests)

cmake_minimum_required(VERSION 3.16)
project(dlks_q261 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
enable_testing()

add_executable(test_cubemap tests/test_cubemap.cpp)
target_include_directories(test_cubemap PRIVATE include)
target_compile_options(test_cubemap PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME cubemap COMMAND test_cubemap)

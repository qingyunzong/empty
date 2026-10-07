cmake_minimum_required(VERSION 3.20)
project(interval_colors LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(interval_colors INTERFACE)
target_include_directories(interval_colors INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

add_executable(interval_colors_tests tests/interval_colors_tests.cpp)
target_link_libraries(interval_colors_tests PRIVATE interval_colors)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(interval_colors_tests PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()
add_test(NAME interval_colors_tests COMMAND interval_colors_tests)

cmake_minimum_required(VERSION 3.20)
project(fencesim LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(fencesim INTERFACE)
target_include_directories(fencesim INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(fencesim INTERFACE -Wall -Wextra -Wpedantic)

add_executable(fencesim_demo src/main.cpp)
target_link_libraries(fencesim_demo PRIVATE fencesim)

enable_testing()
add_executable(fencesim_tests tests/fence_tests.cpp)
target_link_libraries(fencesim_tests PRIVATE fencesim)
add_test(NAME fencesim_tests COMMAND fencesim_tests)

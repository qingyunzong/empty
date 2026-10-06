cmake_minimum_required(VERSION 3.20)
project(fencing_sim LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(fencing_sim INTERFACE)
target_include_directories(fencing_sim INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(fencing_sim INTERFACE -Wall -Wextra -Wpedantic)

enable_testing()
add_subdirectory(tests)

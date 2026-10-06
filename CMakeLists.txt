cmake_minimum_required(VERSION 3.16)
project(packed_column CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(packed_column INTERFACE)
target_include_directories(packed_column INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(packed_column INTERFACE -Wall -Wextra -Wpedantic)

enable_testing()
foreach(t IN ITEMS test_sign_extension test_random_updates test_scan)
    add_executable(${t} tests/${t}.cpp)
    target_link_libraries(${t} PRIVATE packed_column)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

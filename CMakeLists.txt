cmake_minimum_required(VERSION 3.20)
project(cosched CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(cosched INTERFACE)
target_include_directories(cosched INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(cosched INTERFACE -Wall -Wextra -Wpedantic)

enable_testing()
foreach(t IN ITEMS completion destroy shutdown frame_stats)
    add_executable(test_${t} tests/test_${t}.cpp)
    target_link_libraries(test_${t} PRIVATE cosched)
    add_test(NAME ${t} COMMAND test_${t})
endforeach()

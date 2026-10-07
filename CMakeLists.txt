cmake_minimum_required(VERSION 3.20)
project(intcol CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(intcol src/column.cpp)
target_include_directories(intcol PUBLIC include)
target_compile_options(intcol PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
foreach(t basic snapshot scan boundary fuzz)
    add_executable(test_${t} tests/test_${t}.cpp)
    target_include_directories(test_${t} PRIVATE tests)
    target_link_libraries(test_${t} PRIVATE intcol)
    target_compile_options(test_${t} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${t} COMMAND test_${t})
endforeach()

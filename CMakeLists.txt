cmake_minimum_required(VERSION 3.20)
project(skyline LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(skyline src/skyline.cpp)
target_include_directories(skyline PUBLIC include)
target_compile_options(skyline PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
foreach(t IN ITEMS test_skyline test_sources test_snapshot test_model)
    add_executable(${t} tests/${t}.cpp)
    target_link_libraries(${t} PRIVATE skyline)
    target_include_directories(${t} PRIVATE tests)
    target_compile_options(${t} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

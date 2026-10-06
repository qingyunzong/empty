cmake_minimum_required(VERSION 3.20)
project(numimport LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

add_library(numcore src/number_parser.cpp src/column_format.cpp)
target_include_directories(numcore PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)

add_executable(numimport src/main.cpp)
target_link_libraries(numimport PRIVATE numcore)

enable_testing()

add_executable(test_parser tests/test_parser.cpp)
target_link_libraries(test_parser PRIVATE numcore)
add_test(NAME parser COMMAND test_parser)

add_executable(test_exhaustive tests/test_exhaustive.cpp)
target_link_libraries(test_exhaustive PRIVATE numcore)
add_test(NAME exhaustive COMMAND test_exhaustive)

add_test(NAME end_to_end
         COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/tests/end_to_end.sh $<TARGET_FILE:numimport>)

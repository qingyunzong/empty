cmake_minimum_required(VERSION 3.20)
project(scorecli VERSION 1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(score src/parser.cpp)
target_include_directories(score PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
if(MSVC)
    target_compile_options(score PRIVATE /W4)
else()
    target_compile_options(score PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(scorecli src/main.cpp)
target_link_libraries(scorecli PRIVATE score)

enable_testing()
add_executable(score_tests tests/score_tests.cpp)
target_link_libraries(score_tests PRIVATE score)
add_test(NAME score_tests COMMAND score_tests)

cmake_minimum_required(VERSION 3.16)
project(manhattan_path LANGUAGES CXX)

add_library(manhattan_path INTERFACE)
target_include_directories(manhattan_path INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(manhattan_path INTERFACE cxx_std_20)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(manhattan_path INTERFACE -Wall -Wextra)
endif()

enable_testing()

add_executable(manhattan_path_test tests/manhattan_path_test.cpp)
target_link_libraries(manhattan_path_test PRIVATE manhattan_path)

add_test(NAME manhattan_path_test COMMAND manhattan_path_test)

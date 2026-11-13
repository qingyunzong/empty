cmake_minimum_required(VERSION 3.20)
project(dataeng LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dataeng dataeng.cpp)
add_library(dataeng::dataeng ALIAS dataeng)
target_include_directories(dataeng PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_features(dataeng PUBLIC cxx_std_20)

include(CTest)
if(BUILD_TESTING)
    add_executable(dataeng_tests tests/dataeng_tests.cpp)
    target_link_libraries(dataeng_tests PRIVATE dataeng::dataeng)
    add_test(NAME dataeng_tests COMMAND dataeng_tests)
endif()

cmake_minimum_required(VERSION 3.20)
project(spatial_index CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

find_package(Threads REQUIRED)

add_library(spatial INTERFACE)
target_include_directories(spatial INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_options(spatial INTERFACE -Wall -Wextra -Wpedantic)

enable_testing()

foreach(t IN ITEMS test_aabb test_index test_reclaimer test_model_check)
    add_executable(${t} tests/${t}.cpp)
    target_include_directories(${t} PRIVATE tests)
    target_link_libraries(${t} PRIVATE spatial Threads::Threads)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

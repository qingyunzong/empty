cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Threads REQUIRED)

add_library(dlks_formal INTERFACE)
target_include_directories(dlks_formal INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
target_compile_features(dlks_formal INTERFACE cxx_std_20)
target_link_libraries(dlks_formal INTERFACE Threads::Threads)

include(CTest)
if(BUILD_TESTING)
    add_executable(dlks_numa_page_pool_test tests/numa_page_pool_test.cpp)
    target_link_libraries(dlks_numa_page_pool_test PRIVATE
        dlks_formal
        Threads::Threads)
    add_test(NAME dlks_numa_page_pool_test COMMAND dlks_numa_page_pool_test)
endif()

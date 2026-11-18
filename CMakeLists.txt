cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dlks_formal INTERFACE)
add_library(dlks::formal ALIAS dlks_formal)
target_include_directories(dlks_formal INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
target_compile_features(dlks_formal INTERFACE cxx_std_20)

if(PROJECT_IS_TOP_LEVEL)
    set(DLKS_FORMAL_TESTS_DEFAULT ON)
else()
    set(DLKS_FORMAL_TESTS_DEFAULT OFF)
endif()
option(DLKS_FORMAL_BUILD_TESTS "Build dlks_formal tests"
    ${DLKS_FORMAL_TESTS_DEFAULT})

if(DLKS_FORMAL_BUILD_TESTS)
    enable_testing()
    find_package(Threads REQUIRED)

    add_executable(dlks_formal_tests tests/test_dlks.cpp)
    target_link_libraries(dlks_formal_tests PRIVATE
        dlks_formal
        Threads::Threads)
    target_compile_options(dlks_formal_tests PRIVATE
        -Wall -Wextra -Wpedantic)

    add_test(NAME dlks_formal_tests COMMAND dlks_formal_tests)
endif()

include(GNUInstallDirs)
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
install(TARGETS dlks_formal EXPORT dlks_formalTargets)
install(EXPORT dlks_formalTargets
    NAMESPACE dlks::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/dlks_formal)

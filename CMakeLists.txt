cmake_minimum_required(VERSION 3.20)
project(dlks_formal VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(GNUInstallDirs)

add_library(dlks_formal INTERFACE)
add_library(dlks::formal ALIAS dlks_formal)
set_target_properties(dlks_formal PROPERTIES EXPORT_NAME formal)
target_include_directories(
    dlks_formal
    INTERFACE
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)
target_compile_features(dlks_formal INTERFACE cxx_std_20)

include(CTest)
if(BUILD_TESTING)
    add_executable(dlks_formal_tests tests/scheduler_tests.cpp)
    target_link_libraries(dlks_formal_tests PRIVATE dlks_formal)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(
            dlks_formal_tests
            PRIVATE -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
    endif()
    add_test(NAME dlks_formal_tests COMMAND dlks_formal_tests)
endif()

install(TARGETS dlks_formal EXPORT dlks_formalTargets)
install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

include(CMakePackageConfigHelpers)
configure_package_config_file(
    cmake/dlks_formalConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/dlks_formalConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/dlks_formal)
write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/dlks_formalConfigVersion.cmake
    VERSION ${PROJECT_VERSION}
    COMPATIBILITY SameMajorVersion)
install(
    FILES
        ${CMAKE_CURRENT_BINARY_DIR}/dlks_formalConfig.cmake
        ${CMAKE_CURRENT_BINARY_DIR}/dlks_formalConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/dlks_formal)
install(
    EXPORT dlks_formalTargets
    FILE dlks_formalTargets.cmake
    NAMESPACE dlks::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/dlks_formal)

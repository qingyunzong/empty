# CMake generated Testfile for 
# Source directory: /home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace
# Build directory: /home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test([=[test_stable_ids]=] "/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/build/test_stable_ids")
set_tests_properties([=[test_stable_ids]=] PROPERTIES  ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0" _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/CMakeLists.txt;25;add_test;/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/CMakeLists.txt;0;")
add_test([=[test_roundtrip]=] "/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/build/test_roundtrip")
set_tests_properties([=[test_roundtrip]=] PROPERTIES  ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0" _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/CMakeLists.txt;25;add_test;/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/CMakeLists.txt;0;")
add_test([=[test_failure]=] "/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/build/test_failure")
set_tests_properties([=[test_failure]=] PROPERTIES  ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0" _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/CMakeLists.txt;25;add_test;/home/delin/.local/share/gsb-workbench/artifacts/e335bed0f2ae4ed482675d4bb879bf59/run/B/attempt-003/workspace/CMakeLists.txt;0;")

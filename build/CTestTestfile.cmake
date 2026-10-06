# CMake generated Testfile for 
# Source directory: /home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace
# Build directory: /home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/build
# 
# This file includes the relevant testing commands required for 
# testing this directory and lists subdirectories to be tested as well.
add_test(unit "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/build/inspector_tests")
set_tests_properties(unit PROPERTIES  _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/CMakeLists.txt;21;add_test;/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/CMakeLists.txt;0;")
add_test(cli_sample "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/build/inspector-cli" "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/tests/data/sample1.txt")
set_tests_properties(cli_sample PROPERTIES  PASS_REGULAR_EXPRESSION "status: ok
cost: 5" _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/CMakeLists.txt;23;add_test;/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/CMakeLists.txt;0;")
add_test(cli_unreachable "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/build/inspector-cli" "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/tests/data/unreachable.txt")
set_tests_properties(cli_unreachable PROPERTIES  PASS_REGULAR_EXPRESSION "status: unreachable" _BACKTRACE_TRIPLES "/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/CMakeLists.txt;28;add_test;/home/delin/.local/share/gsb-workbench/artifacts/342261901b014f87a7c26b52ace05d0b/run/A/attempt-002/workspace/CMakeLists.txt;0;")

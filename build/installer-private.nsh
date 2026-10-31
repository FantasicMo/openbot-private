; Reuse the upstream install-directory and update safeguards with a separate data root.
; This edition does not register or remove the official openbot:// scheme.
!define OPENBOT_PRIVATE_INSTALL
!define OPENBOT_DATA_DIRECTORY "OpenBot Private"
!include "${BUILD_RESOURCES_DIR}\installer.nsh"

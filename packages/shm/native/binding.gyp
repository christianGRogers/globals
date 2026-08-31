{
  "targets": [
    {
      "target_name": "globals_shm",
      "sources": ["addon.c"],
      # This is the one file in the repository that can corrupt memory, and it was compiled
      # with default warnings. Errors rather than warnings, because a warning nobody reads
      # in a file doing its own pointer arithmetic over a mapped region is the same as no
      # warning at all.
      "cflags": ["-Wall", "-Wextra", "-Werror", "-Wshadow", "-Wconversion"],
      # Pinned so the addon declares the Node-API level it actually targets rather than
      # inheriting whatever the build host's headers happened to offer. Node-API 8 is
      # Node 12 and later, which is well below the engines floor.
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        # Without this the published macOS prebuild's minimum OS is set by whichever runner
        # image the release happened to use, and it moves without a code change.
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "WARNING_CFLAGS": ["-Wall", "-Wextra", "-Werror", "-Wshadow", "-Wconversion"]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "WarningLevel": "4",
          "TreatWarningAsError": "true"
        }
      }
    }
  ]
}

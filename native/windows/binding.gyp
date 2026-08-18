{
  "targets": [
    {
      "target_name": "threadleaf_state_lock",
      "sources": ["../state_lock.c"],
      "defines": ["NAPI_VERSION=10"],
      "win_delay_load_hook": "true",
      "libraries": ["advapi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "WarningLevel": 4,
          "WarnAsError": "true",
          "CompileAs": "CompileAsC"
        }
      }
    }
  ]
}

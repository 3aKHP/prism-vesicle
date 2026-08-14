# update-config wrapper - PowerShell
#
# Usage:
#   update_config.ps1 <config-subcommand> [args...]
#
# Thin adapter: reconstructs the exact Vesicle CLI from Host-injected
# VESICLE_SELF_EXECUTABLE / VESICLE_SELF_ENTRYPOINT, invokes the non-model-
# visible `vesicle config` JSON contract, and relays stdout and exit code
# unchanged. No path, schema, validation, or write logic lives here.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if ($args.Count -lt 1) {
  [Console]::Error.WriteLine("Usage: update_config.ps1 <path|show|set|add-provider|add-model|add-mcp|remove-model|remove-provider|unset|env-set-empty|env-set-proxy|env-remove|validate> [args...]")
  exit 2
}

if (-not $env:VESICLE_SELF_EXECUTABLE) {
  [Console]::Out.WriteLine('{"ok":false,"error":"Vesicle self-invocation is not configured; update-config must run through the Host runtime."}')
  exit 1
}

if ($env:VESICLE_SELF_ENTRYPOINT) {
  & $env:VESICLE_SELF_EXECUTABLE $env:VESICLE_SELF_ENTRYPOINT config @args
}
else {
  & $env:VESICLE_SELF_EXECUTABLE config @args
}
exit $LASTEXITCODE

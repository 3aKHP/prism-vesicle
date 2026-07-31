# skillify publish wrapper - PowerShell
#
# Usage:
#   publish_skill.ps1 validate <tmp/skillify/<name>>
#   publish_skill.ps1 publish  <tmp/skillify/<name>> <project|installed>
#
# Thin adapter: reconstructs the exact Vesicle CLI from Host-injected
# VESICLE_SELF_EXECUTABLE / VESICLE_SELF_ENTRYPOINT, invokes the non-model-
# visible skills validate|publish-draft JSON contract, and relays stdout and
# exit code unchanged. No path, hash, copy, staging, or cleanup logic lives here.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Invoke-Vesicle {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CmdArgs
  )
  if ($env:VESICLE_SELF_ENTRYPOINT) {
    & $env:VESICLE_SELF_EXECUTABLE $env:VESICLE_SELF_ENTRYPOINT @CmdArgs
  }
  else {
    & $env:VESICLE_SELF_EXECUTABLE @CmdArgs
  }
}

if ($args.Count -lt 1) {
  [Console]::Error.WriteLine("Usage: publish_skill.ps1 <validate|publish> ...")
  exit 2
}

$op = $args[0]
if ($args.Count -gt 1) {
  $rest = $args[1..($args.Count - 1)]
}
else {
  $rest = @()
}

switch ($op) {
  'validate' {
    if ($rest.Count -ne 1) {
      [Console]::Error.WriteLine("Usage: publish_skill.ps1 validate <tmp/skillify/<name>>")
      exit 2
    }
    if (-not $env:VESICLE_SELF_EXECUTABLE) {
      $obj = [ordered]@{
        schema                       = 'vesicle.skill-draft/v1'
        operation                    = 'validate'
        ok                           = $false
        source                       = ''
        diagnostics                  = @(@{
          code    = 'publication-failed'
          message = 'Vesicle self-invocation is not configured; the publisher must run through the Host runtime.'
        })
        draftRetained                = $true
        currentSessionCatalogChanged = $false
        catalogRefresh               = 'new-session-required'
      }
      [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
      exit 1
    }
    Invoke-Vesicle skills validate $rest[0] --draft --json
    exit $LASTEXITCODE
  }
  'publish' {
    if ($rest.Count -ne 2) {
      [Console]::Error.WriteLine("Usage: publish_skill.ps1 publish <tmp/skillify/<name>> <project|installed>")
      exit 2
    }
    if ($rest[1] -notin 'project', 'installed') {
      [Console]::Error.WriteLine("Target must be 'project' or 'installed', got: $($rest[1])")
      exit 2
    }
    if (-not $env:VESICLE_SELF_EXECUTABLE) {
      $obj = [ordered]@{
        schema                       = 'vesicle.skill-draft/v1'
        operation                    = 'publish'
        ok                           = $false
        source                       = ''
        diagnostics                  = @(@{
          code    = 'publication-failed'
          message = 'Vesicle self-invocation is not configured; the publisher must run through the Host runtime.'
        })
        draftRetained                = $true
        currentSessionCatalogChanged = $false
        catalogRefresh               = 'new-session-required'
      }
      [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
      exit 1
    }
    # Validate quietly first. On failure the validation JSON and exit code pass
    # through unchanged. On success (--quiet-success) nothing is printed.
    Invoke-Vesicle skills validate $rest[0] --draft --json --quiet-success
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Invoke-Vesicle skills publish-draft $rest[0] --target $rest[1] --json
    exit $LASTEXITCODE
  }
  default {
    [Console]::Error.WriteLine("Unknown operation '$op' (expected 'validate' or 'publish')")
    exit 2
  }
}

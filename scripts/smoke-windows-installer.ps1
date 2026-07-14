param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [string]$SmokeRoot = (Join-Path $PWD "smoke\installer")
)

$ErrorActionPreference = "Stop"
$InstallerPath = (Resolve-Path $InstallerPath).Path
$SmokeRoot = [System.IO.Path]::GetFullPath($SmokeRoot)
$InstallDir = Join-Path $SmokeRoot "installed"
$ProjectDir = Join-Path $SmokeRoot "project"
$ConfigDir = Join-Path $SmokeRoot "isolated-config"
$InstallLog = Join-Path $SmokeRoot "install.log"
$UninstallLog = Join-Path $SmokeRoot "uninstall.log"
$OriginalProcessPath = $env:Path
$UserConfigDir = Join-Path $env:APPDATA "prism-vesicle"
$Sentinel = Join-Path $UserConfigDir ("installer-smoke-" + [guid]::NewGuid().ToString("N") + ".txt")
$ProjectSentinel = Join-Path $ProjectDir "keep-after-uninstall.txt"

function Invoke-CheckedProcess {
    param([string]$FilePath, [string[]]$Arguments)
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "$FilePath exited with $($process.ExitCode)."
    }
}

function Test-UserPathEntry {
    param([string]$Entry)
    $target = $Entry.TrimEnd("\").ToLowerInvariant()
    $path = [Environment]::GetEnvironmentVariable("Path", "User")
    return @($path -split ";" | ForEach-Object { $_.Trim().TrimEnd("\").ToLowerInvariant() }) -contains $target
}

New-Item -ItemType Directory -Force $SmokeRoot, $ProjectDir, $ConfigDir, $UserConfigDir | Out-Null
Set-Content -LiteralPath $Sentinel -Value "preserve user configuration"
Set-Content -LiteralPath $ProjectSentinel -Value "preserve project data"

try {
    Invoke-CheckedProcess $InstallerPath @(
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/DIR=$InstallDir",
        "/LOG=$InstallLog"
    )

    $Executable = Join-Path $InstallDir "prism-vesicle.exe"
    foreach ($required in @($Executable, (Join-Path $InstallDir "vesicle.cmd"), (Join-Path $InstallDir "harness-manifest.json"), (Join-Path $InstallDir "assets"), (Join-Path $InstallDir "host-assets"), (Join-Path $InstallDir "unins000.exe"))) {
        if (-not (Test-Path -LiteralPath $required)) { throw "Installed payload is missing: $required" }
    }
    if (-not (Test-UserPathEntry $InstallDir)) { throw "The per-user PATH does not contain the install directory." }
    $DirectoryMenuKey = "Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\PrismVesicle"
    $BackgroundMenuKey = "Registry::HKEY_CURRENT_USER\Software\Classes\Directory\Background\shell\PrismVesicle"
    if (-not (Test-Path -LiteralPath $DirectoryMenuKey)) { throw "Directory context menu was not registered." }
    if (-not (Test-Path -LiteralPath $BackgroundMenuKey)) { throw "Directory background context menu was not registered." }
    $DirectoryCommand = (Get-Item -LiteralPath (Join-Path $DirectoryMenuKey "command")).GetValue("")
    $BackgroundCommand = (Get-Item -LiteralPath (Join-Path $BackgroundMenuKey "command")).GetValue("")
    if ($DirectoryCommand -ne ('"' + $Executable + '" "%1"')) {
        throw "Directory context menu command is incorrect: $DirectoryCommand"
    }
    if ($BackgroundCommand -ne ('"' + $Executable + '" "%V"')) {
        throw "Directory background context menu command is incorrect: $BackgroundCommand"
    }

    $MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$MachinePath;$UserPath"
    $PathProject = Join-Path $SmokeRoot "path-project"
    New-Item -ItemType Directory -Force $PathProject | Out-Null
    Push-Location $PathProject
    try {
        $ResolvedCommand = Get-Command vesicle -CommandType Application -ErrorAction Stop
        if ($ResolvedCommand.Source -ne (Join-Path $InstallDir "vesicle.cmd")) {
            throw "PATH resolved vesicle to an unexpected command: $($ResolvedCommand.Source)"
        }
        & vesicle assets materialize assets/prompts/shared/vesicle-base.md
        if ($LASTEXITCODE -ne 0) { throw "PATH-resolved vesicle command failed." }
        if (-not (Test-Path -LiteralPath (Join-Path $PathProject "assets\prompts\shared\vesicle-base.md"))) {
            throw "PATH-resolved vesicle command did not use the invocation directory as the project root."
        }
    }
    finally {
        Pop-Location
    }

    Push-Location $ProjectDir
    try {
        $env:VESICLE_CONFIG_DIR = $ConfigDir
        & $Executable debug markdown-runtime
        if ($LASTEXITCODE -ne 0) { throw "Installed markdown runtime diagnostic failed." }
        & $Executable assets status
        if ($LASTEXITCODE -ne 0) { throw "Installed assets status failed." }
        & $Executable prompt shape --engine etl
        if ($LASTEXITCODE -ne 0) { throw "Installed prompt shape failed." }
    }
    finally {
        Pop-Location
        Remove-Item Env:VESICLE_CONFIG_DIR -ErrorAction SilentlyContinue
    }

    $Uninstaller = Join-Path $InstallDir "unins000.exe"
    Invoke-CheckedProcess $Uninstaller @(
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/LOG=$UninstallLog"
    )

    if (Test-Path -LiteralPath $Executable) { throw "Uninstall left the application executable behind." }
    if (Test-UserPathEntry $InstallDir) { throw "Uninstall left the install directory in the per-user PATH." }
    if (Test-Path -LiteralPath $DirectoryMenuKey) { throw "Uninstall left the directory context menu behind." }
    if (Test-Path -LiteralPath $BackgroundMenuKey) { throw "Uninstall left the directory background context menu behind." }
    if (-not (Test-Path -LiteralPath $Sentinel)) { throw "Uninstall removed user configuration data." }
    if (-not (Test-Path -LiteralPath $ProjectSentinel)) { throw "Uninstall removed project data." }
    Write-Host "Windows installer smoke passed: $InstallerPath"
}
finally {
    $env:Path = $OriginalProcessPath
    Remove-Item -LiteralPath $Sentinel -Force -ErrorAction SilentlyContinue
}

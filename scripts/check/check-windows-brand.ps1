param(
    [Parameter(Mandatory = $true)]
    [string]$CanonicalIcon,
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [string]$Installer,
    [string]$Uninstaller
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
$DrawingAssemblies = @([System.Drawing.Bitmap].Assembly.Location, [System.Drawing.Color].Assembly.Location)
Add-Type -ReferencedAssemblies $DrawingAssemblies -TypeDefinition @"
using System;
using System.Drawing;

public static class PrismIconPixels {
    public static double Distance(Bitmap left, Bitmap right) {
        if (left.Width != 32 || left.Height != 32 || right.Width != 32 || right.Height != 32) {
            throw new InvalidOperationException("Windows brand verification requires normalized 32x32 icon bitmaps.");
        }
        double sum = 0;
        for (var y = 0; y < 32; y++) {
            for (var x = 0; x < 32; x++) {
                var a = left.GetPixel(x, y);
                var b = right.GetPixel(x, y);
                var aa = a.A / 255.0;
                var ba = b.A / 255.0;
                var alpha = aa - ba;
                var red = (a.R / 255.0 * aa) - (b.R / 255.0 * ba);
                var green = (a.G / 255.0 * aa) - (b.G / 255.0 * ba);
                var blue = (a.B / 255.0 * aa) - (b.B / 255.0 * ba);
                sum += alpha * alpha + red * red + green * green + blue * blue;
            }
        }
        return Math.Sqrt(sum / (32 * 32 * 4));
    }
}
"@

function Get-AssociatedIconBitmap {
    param([string]$Path)
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($resolved)
    if ($null -eq $icon) { throw "Could not extract an associated icon from $Path." }
    try { return $icon.ToBitmap() }
    finally { $icon.Dispose() }
}

function Get-CanonicalIconBitmap {
    param([string]$Path, [int]$Size)
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $icon = [System.Drawing.Icon]::new($resolved, $Size, $Size)
    try {
        $bitmap = $icon.ToBitmap()
        try { return [System.Drawing.Bitmap]::new($bitmap, 32, 32) }
        finally { $bitmap.Dispose() }
    }
    finally { $icon.Dispose() }
}

function Measure-IconDistance {
    param([System.Drawing.Bitmap]$Left, [System.Drawing.Bitmap]$Right)
    return [PrismIconPixels]::Distance($Left, $Right)
}

function Assert-BrandedIcon {
    param([string]$Path, [string]$CanonicalIcon)
    $actual = Get-AssociatedIconBitmap $Path
    try {
        [double]$minimum = 1
        foreach ($size in @(16, 20, 24, 32, 40, 48)) {
            $candidate = Get-CanonicalIconBitmap $CanonicalIcon $size
            try { $minimum = [Math]::Min($minimum, (Measure-IconDistance $actual $candidate)) }
            finally { $candidate.Dispose() }
        }
        # Bun's Windows resource writer and the Shell icon APIs may select and
        # resample different ICO frames. A perceptual pixel oracle proves that
        # the extracted PE icon is the mono Prism mark without requiring an
        # impossible byte-for-byte match after that native resampling.
        if ($minimum -gt 0.12) { throw "Icon mismatch: $Path does not resemble the canonical Windows brand icon (distance $minimum)." }
    }
    finally { $actual.Dispose() }
}

function Assert-File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required Windows brand file is missing: $Path" }
}

function Get-ExpectedVersion {
    $PackageJson = Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\..\package.json") -Raw | ConvertFrom-Json
    $Core = ($PackageJson.version -split '-', 2)[0]
    if ($Core -notmatch '^\d+\.\d+\.\d+$') { throw "package.json version cannot be converted to PE VersionInfo: $($PackageJson.version)" }
    return "$Core.0"
}

Assert-File $CanonicalIcon
Assert-File $Executable
foreach ($path in @($Executable, $Installer, $Uninstaller)) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    Assert-File $path
    Assert-BrandedIcon $path $CanonicalIcon
}

$info = (Get-Item -LiteralPath $Executable).VersionInfo
$expectedVersion = Get-ExpectedVersion
foreach ($pair in @{
    ProductName = "Prism Vesicle"
    CompanyName = "3aKHP"
    FileDescription = "Open-source Agent Harness host and TUI for durable Prism Engine workflows."
    LegalCopyright = "Copyright (c) 2026 3aKHP"
}.GetEnumerator()) {
    if ($info.($pair.Key) -ne $pair.Value) {
        throw "VersionInfo $($pair.Key) mismatch: '$($info.($pair.Key))'."
    }
}
if ($info.ProductVersion -ne $expectedVersion) { throw "VersionInfo ProductVersion mismatch: '$($info.ProductVersion)', expected '$expectedVersion'." }
if ($info.FileVersion -ne $expectedVersion) { throw "VersionInfo FileVersion mismatch: '$($info.FileVersion)', expected '$expectedVersion'." }

if (-not [string]::IsNullOrWhiteSpace($Installer)) {
    $installerInfo = (Get-Item -LiteralPath $Installer).VersionInfo
    foreach ($pair in @{
        ProductName = "Prism Vesicle"
        CompanyName = "3aKHP"
        FileDescription = "Prism Vesicle guided installer"
        ProductVersion = $expectedVersion
        FileVersion = $expectedVersion
    }.GetEnumerator()) {
        if ($installerInfo.($pair.Key) -ne $pair.Value) {
            throw "Installer VersionInfo $($pair.Key) mismatch: '$($installerInfo.($pair.Key))'."
        }
    }
}

Write-Host "Windows brand verification passed for $Executable"

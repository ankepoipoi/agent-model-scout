# Installs agent-model-scout into a DeepSeek Harness profile.
#
#   .\install.ps1              # install / update files + patch entry
#   .\install.ps1 -DryRun      # show what would change
#
# Idempotent: re-running only refreshes files and never duplicates the patch entry.
# Close DeepSeek Harness first so the plugin loads on next start.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
if (-not (Test-Path (Join-Path $source 'lib\index.js'))) {
    throw "install.ps1 must sit next to the plugin package (lib\index.js not found in $source)."
}

$patchPath = Join-Path $Profile 'cordis.patch.yml'
if (-not (Test-Path $patchPath)) {
    throw "Profile patch file not found: $patchPath. Is '$Profile' the right profile?"
}

$target = Join-Path $Profile 'node_modules\agent-model-scout'

Write-Host "source : $source"
Write-Host "target : $target"
Write-Host "patch  : $patchPath"

if ($DryRun) {
    Write-Host "`n[dry run] would copy package.json + lib\ into the target and append the scout entry."
    return
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*' }
if ($running) {
    Write-Warning "DeepSeek Harness appears to be running. Restart it after installing for the plugin to load."
}

# 1. Refresh the package files.
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Force (Join-Path $source 'package.json') $target
if (Test-Path (Join-Path $target 'lib')) {
    Remove-Item -Recurse -Force (Join-Path $target 'lib')
}
Copy-Item -Recurse -Force (Join-Path $source 'lib') (Join-Path $target 'lib')
Write-Host "copied package files."

# 2. Append the composition entry once.
$patch = Get-Content -Raw -Path $patchPath
if ($patch -match '(?m)^\s*name:\s*"?agent-model-scout"?\s*$') {
    Write-Host "patch entry already present; left untouched."
} else {
    $entry = @(
        ''
        '- insert:'
        '    - id: scout'
        '      name: "agent-model-scout"'
        '      config:'
        '        candidates: []'
        '        lambda: 0.5'
        '        topK: 4'
        '        maxProbeTokens: 500'
        '        probeTimeoutMs: 60000'
        '        fixedOverheadTokens: 3000'
    ) -join "`n"
    Add-Content -Path $patchPath -Value $entry -Encoding utf8
    Write-Host "appended patch entry."
}

Write-Host "`nDone. Restart DeepSeek Harness, then run:  /scout <task>"

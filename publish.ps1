# Commits this package and publishes it to GitHub.
#
# Run this in a NORMAL PowerShell window (not inside the DSH sandbox - the
# sandbox has no network egress, so git cannot reach github.com from there).
#
#   .\publish.ps1 -Owner your-github-name
#   .\publish.ps1 -Owner your-github-name -Visibility private
#
# With the GitHub CLI installed and authenticated (`gh auth login`), the script
# creates the repository and pushes in one step. Without `gh`, it makes the
# local commit and prints the two commands to finish the job in the browser.

[CmdletBinding()]
param(
    [string]$Owner = "",
    [string]$Repo = "agent-model-scout",
    [ValidateSet("public", "private")]
    [string]$Visibility = "public",
    [string]$UserName = "",
    [string]$UserEmail = "",
    [string]$Message = "agent-model-scout v0.1.0"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".git")) {
    throw "No git repository here. Run this script from the agent-model-scout package root."
}

function Get-GitValue([string]$key) {
    $value = git config $key 2>$null
    if ($LASTEXITCODE -ne 0) { return "" }
    return ($value | Out-String).Trim()
}

# 1. Identity - a commit needs one, and this machine has no global config.
if ([string]::IsNullOrWhiteSpace($UserName)) { $UserName = Get-GitValue "user.name" }
if ([string]::IsNullOrWhiteSpace($UserName)) { $UserName = Read-Host "git user.name (your GitHub display name)" }

if ([string]::IsNullOrWhiteSpace($UserEmail)) { $UserEmail = Get-GitValue "user.email" }
if ([string]::IsNullOrWhiteSpace($UserEmail)) { $UserEmail = Read-Host "git user.email (e.g. you@users.noreply.github.com)" }

git config user.name $UserName
git config user.email $UserEmail

# 2. Commit whatever is staged or modified, if there is anything to commit.
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m $Message | Out-Null
    Write-Host "committed: $Message"
} else {
    Write-Host "nothing new to commit."
}

git branch -M main | Out-Null

# 3. Publish.
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
    gh auth status 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        if ([string]::IsNullOrWhiteSpace($Owner)) {
            $Owner = (gh api user --jq .login).Trim()
        }
        $target = "$Owner/$Repo"
        Write-Host "creating $target ($Visibility) and pushing..."
        gh repo create $target "--$Visibility" --source . --remote origin --push
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Host "Done: https://github.com/$target"
            exit 0
        }
        Write-Warning "gh repo create failed; falling back to manual instructions."
    } else {
        Write-Warning "gh is installed but not authenticated. Run: gh auth login"
    }
}

$manual = @(
    ""
    "No authenticated gh CLI - finish in two steps:"
    ""
    "  1. Create an empty repository named '${Repo}' on https://github.com/new"
    "     (public or private, no README, no .gitignore)."
    ""
    "  2. Then run:"
    ""
    "     git remote add origin https://github.com/<your-name>/${Repo}.git"
    "     git push -u origin main"
    ""
    "If the remote already exists, use:  git remote set-url origin <url>"
)
Write-Host ($manual -join "`n")

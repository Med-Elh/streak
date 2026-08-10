# Stamps a cache-busting ?v=N on every local CSS link and JS import.
#
#   .\bump-version.ps1            bump to the next number
#   .\bump-version.ps1 -Version 7 set it explicitly
#
# Run it after any change to css/ or js/, then commit. GitHub Pages serves
# assets with a ten-minute max-age and phones hold them far longer than that;
# a changed URL is the only thing that reliably defeats both.
#
# Windows PowerShell only - no install, nothing to add to the project.

param([int]$Version = 0)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$stampFile = Join-Path $root '.version'

if ($Version -le 0) {
    $current = 0
    if (Test-Path $stampFile) { $current = [int](Get-Content $stampFile -Raw).Trim() }
    $Version = $current + 1
}

# Local assets only. Anything on https:// (Chart.js, supabase-js, the fonts) is
# already pinned by its own URL and must not be touched.
$cssPattern = '(?<attr>href=")(?<path>(?:\./)?css/[^"?]+\.css)(?:\?v=\d+)?(?<close>")'
$jsPattern  = "(?<quote>['`"])(?<path>\.{1,2}/[^'`"?]+\.js)(?:\?v=\d+)?\k<quote>"

$utf8 = New-Object System.Text.UTF8Encoding($false)
$touched = 0
$stamps  = 0

$files = @()
$files += Get-ChildItem -Path $root -Filter *.html -File
$files += Get-ChildItem -Path (Join-Path $root 'js') -Filter *.js -File

foreach ($file in $files) {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    $before = $text

    $text = [regex]::Replace($text, $cssPattern, {
        param($m) "$($m.Groups['attr'].Value)$($m.Groups['path'].Value)?v=$Version$($m.Groups['close'].Value)"
    })
    $text = [regex]::Replace($text, $jsPattern, {
        param($m) "$($m.Groups['quote'].Value)$($m.Groups['path'].Value)?v=$Version$($m.Groups['quote'].Value)"
    })

    if ($text -ne $before) {
        [System.IO.File]::WriteAllText($file.FullName, $text, $utf8)
        $count = ([regex]::Matches($text, "\?v=$Version")).Count
        $stamps += $count
        $touched++
        "  {0,-18} {1} stamped" -f $file.Name, $count
    }
}

Set-Content -Path $stampFile -Value $Version -Encoding ascii -NoNewline

""
"Version $Version - $stamps references across $touched files."
"Commit and push, then hard-refresh once. Later updates pick themselves up."

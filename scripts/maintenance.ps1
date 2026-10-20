param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
try {
    if (![IO.Path]::IsPathRooted($NodePath) -or !(Test-Path -LiteralPath $NodePath -PathType Leaf) -or [IO.Path]::GetFileName($NodePath) -ine 'node.exe') {
        throw 'A valid absolute Node.js executable path is required.'
    }
    $root = Split-Path -Parent $PSScriptRoot
    $entry = Join-Path $root 'server.mjs'
    # The scheduled PowerShell host starts hidden. Invoke synchronously so the
    # scheduler owns the Node lifetime and its IgnoreNew policy remains effective.
    & $NodePath $entry --sync-once --no-browser
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}

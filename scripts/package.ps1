$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$archivePath = Join-Path $dist 'Dual-Net-Switcher-portable.zip'
$files = @('server.mjs', 'package.json', 'README.md', 'config.example.json')
$files += @(Get-ChildItem -LiteralPath $root -Filter '*.cmd' -File | ForEach-Object Name)
foreach ($directory in @('lib','platform','public','scripts','tests')) {
    $files += @(Get-ChildItem -LiteralPath (Join-Path $root $directory) -File -Recurse | ForEach-Object { $_.FullName.Substring($root.Length + 1) })
}
$files += @('docs\ARCHITECTURE.md','docs\DESIGN.md','docs\VERIFICATION.md','docs\CODE_REVIEW.md')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $files) {
        $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
        if (!$full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escaped project root.' }
        if (!(Test-Path -LiteralPath $full -PathType Leaf)) { throw "Missing package input: $relative" }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $full, $relative.Replace('\','/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose(); $stream.Dispose() }
$result = Get-Item -LiteralPath $archivePath
Write-Output ($result.FullName + ' (' + $result.Length + ' bytes)')

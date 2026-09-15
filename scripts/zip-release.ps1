param([string]$SourcePath,[string]$DestinationPath,[string]$ReleaseRoot)
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\') + '\'
$taskSource = [System.IO.Path]::GetFullPath($SourcePath)
$taskDestination = [System.IO.Path]::GetFullPath($DestinationPath)
if (-not $taskSource.StartsWith($taskRoot,[System.StringComparison]::OrdinalIgnoreCase) -or -not $taskDestination.StartsWith($taskRoot,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Release paths must stay inside the release directory' }
if (Test-Path -LiteralPath $taskDestination -PathType Leaf) { Remove-Item -LiteralPath $taskDestination }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($taskSource,$taskDestination,[System.IO.Compression.CompressionLevel]::Optimal,$true)

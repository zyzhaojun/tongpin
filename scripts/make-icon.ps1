$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskAssetDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
[void][System.IO.Directory]::CreateDirectory($taskAssetDir)
$taskBitmap = New-Object System.Drawing.Bitmap 256,256
$taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
$taskGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$taskBackground = [System.Drawing.ColorTranslator]::FromHtml('#166b54')
$taskGraphics.Clear($taskBackground)
$taskPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White),12
$taskBrush = New-Object System.Drawing.SolidBrush $taskBackground
$taskGraphics.DrawRectangle($taskPen,38,54,144,104)
$taskGraphics.FillRectangle($taskBrush,76,96,144,104)
$taskGraphics.DrawRectangle($taskPen,76,96,144,104)
$taskGraphics.DrawLine($taskPen,125,216,171,216)
$taskStream = New-Object System.IO.MemoryStream
$taskBitmap.Save($taskStream,[System.Drawing.Imaging.ImageFormat]::Png)
$taskPng = $taskStream.ToArray()
$taskFile = [System.IO.File]::Create((Join-Path $taskAssetDir 'icon.ico'))
$taskWriter = New-Object System.IO.BinaryWriter $taskFile
$taskWriter.Write([uint16]0); $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]1)
$taskWriter.Write([byte]0); $taskWriter.Write([byte]0); $taskWriter.Write([byte]0); $taskWriter.Write([byte]0)
$taskWriter.Write([uint16]1); $taskWriter.Write([uint16]32)
$taskWriter.Write([uint32]$taskPng.Length); $taskWriter.Write([uint32]22); $taskWriter.Write($taskPng)
$taskWriter.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose(); $taskStream.Dispose(); $taskPen.Dispose(); $taskBrush.Dispose()

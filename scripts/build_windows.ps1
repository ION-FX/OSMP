# Build the OSMP Windows desktop client (PyInstaller onedir + zip).
#
# Run on Windows with Python 3.10+ available as `python`:
#   pip install pyinstaller pyside6 -r server\requirements.txt
#   scripts\build_windows.ps1
#
# A static ffmpeg.exe must exist at vendor\ffmpeg\ffmpeg.exe before building
# (CI downloads one from BtbN's ffmpeg builds; locally you can drop any
# win64 ffmpeg.exe there). PyInstaller packs it into the bundle so downloads
# and transcoding work out of the box.
#
# Output: dist\osmp_desktop\ (the app) and dist\osmp-windows-x64.zip
param([switch]$SkipZip)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path "vendor\ffmpeg\ffmpeg.exe")) {
  Write-Host "!! vendor\ffmpeg\ffmpeg.exe missing — downloads would need ffmpeg on PATH."
  Write-Host "   Get a static build from https://github.com/BtbN/FFmpeg-Builds/releases"
}

Write-Host "-> PyInstaller onedir bundle (this takes a few minutes)"
python -m PyInstaller --noconfirm --clean --onedir `
  --name osmp_desktop `
  --paths "$Root\server" `
  --add-data "$Root\webui;webui" `
  --add-data "$Root\vendor\ffmpeg\ffmpeg.exe;vendor\ffmpeg" `
  --collect-submodules yt_dlp `
  --collect-submodules mutagen `
  --hidden-import uvicorn.logging `
  --hidden-import uvicorn.loops --hidden-import uvicorn.loops.auto `
  --hidden-import uvicorn.protocols --hidden-import uvicorn.protocols.http `
  --hidden-import uvicorn.protocols.http.auto `
  --hidden-import uvicorn.protocols.websockets `
  --hidden-import uvicorn.protocols.websockets.auto `
  --hidden-import uvicorn.lifespan --hidden-import uvicorn.lifespan.on `
  --hidden-import uvicorn.protocols.http.h11_impl `
  --hidden-import uvicorn.protocols.websockets.wsproto_impl `
  --hidden-import websockets.legacy.server `
  --hidden-import platformdirs `
  --collect-submodules pkg_resources `
  desktop\osmp_desktop.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
if (-not (Test-Path "dist\osmp_desktop\osmp_desktop.exe")) { throw "PyInstaller output missing" }

if ($SkipZip) { Write-Host "-> skip zip"; exit 0 }

Write-Host "-> smoke test (offscreen Qt + embedded server)"
$out = & .\dist\osmp_desktop\osmp_desktop.exe --smoke --data "$env:TEMP\osmp-win-smoke" 2>&1 | Out-String
Write-Host ($out.Trim() -split "`n" | Select-Object -Last 4)
if ($out -notmatch "SMOKE_OK") { throw "smoke test failed (no SMOKE_OK)" }
Write-Host "   smoke passed"

Write-Host "-> zip bundle"
$dest = "dist\osmp-windows-x64.zip"
if (Test-Path $dest) { Remove-Item $dest }
Compress-Archive -Path "dist\osmp_desktop\*" -DestinationPath $dest
$size = "{0:N1} MB" -f ((Get-Item $dest).Length / 1MB)
Write-Host "-> $dest ($size)"

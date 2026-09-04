# Creates a Desktop + Start Menu shortcut that launches InkNote straight from
# this project folder, so updating the app is just "extract the new files".
#
#   npm run shortcut
#
# The shortcut points at Electron's own exe rather than at npm, so it opens
# with no console window behind it, exactly like the installed build.

$ErrorActionPreference = 'Stop'

$project  = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $project 'node_modules\electron\dist\electron.exe'
$icon     = Join-Path $project 'build\icon.ico'

if (-not (Test-Path $electron)) {
  Write-Host ""
  Write-Host "Electron isn't installed in this folder yet." -ForegroundColor Yellow
  Write-Host "Run 'npm install' first, then try again."
  Write-Host ""
  exit 1
}

function New-InkNoteShortcut([string]$linkPath) {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($linkPath)
  $sc.TargetPath       = $electron
  $sc.Arguments        = '.'
  $sc.WorkingDirectory = $project
  $sc.IconLocation     = "$icon,0"
  $sc.Description      = 'InkNote — notes, drawing and boards'
  $sc.Save()
  Write-Host "  created  $linkPath" -ForegroundColor Green
}

# GetFolderPath handles a OneDrive-redirected Desktop correctly; a hand-built
# "$HOME\Desktop" path does not.
$desktop   = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'InkNote.lnk'

Write-Host ""
New-InkNoteShortcut (Join-Path $desktop 'InkNote.lnk')
New-InkNoteShortcut $startMenu
Write-Host ""
Write-Host "Done. Launch InkNote from your desktop or Start Menu." -ForegroundColor Cyan
Write-Host "To update from now on, just extract a new zip over this folder." -ForegroundColor Cyan
Write-Host ""

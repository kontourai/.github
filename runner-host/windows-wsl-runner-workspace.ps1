[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Provision', 'Attach', 'InstallBootTask', 'Compact')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$VhdPath,

  [ValidateRange(1, 65536)]
  [int]$VhdSizeGB = 48,

  [ValidateNotNullOrEmpty()]
  [string]$DistroName = 'Ubuntu',

  [ValidateNotNullOrEmpty()]
  [string]$BootTaskName = 'Kontour WSL runner workspace VHD attach',

  [switch]$ConfirmIdle
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell session.'
  }
}

function Assert-VhdPath {
  $parent = Split-Path -Parent $VhdPath
  if ([string]::IsNullOrWhiteSpace($parent) -or -not [IO.Path]::IsPathRooted($VhdPath)) {
    throw 'VhdPath must be an absolute Windows path.'
  }
  if ((Test-Path -LiteralPath $VhdPath) -and (Get-Item -LiteralPath $VhdPath).PSIsContainer) {
    throw "VhdPath is a directory: $VhdPath"
  }
  return $parent
}

function Attach-WorkspaceVhd {
  if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
    throw "VHD does not exist: $VhdPath"
  }
  $image = Get-DiskImage -ImagePath $VhdPath -ErrorAction SilentlyContinue
  if (-not $image -or -not $image.Attached) {
    Mount-DiskImage -ImagePath $VhdPath -NoDriveLetter | Out-Null
  }
  $disk = Get-DiskImage -ImagePath $VhdPath | Get-Disk
  if ($disk.IsOffline) {
    Set-Disk -Number $disk.Number -IsOffline $false
  }
  Write-Output "Attached VHD $VhdPath as disk $($disk.Number). Format and mount it only from the $DistroName WSL bootstrap path."
}

Assert-Administrator
$parent = Assert-VhdPath

switch ($Mode) {
  'Provision' {
    if (Test-Path -LiteralPath $VhdPath) {
      throw "Refusing to overwrite existing VHD: $VhdPath"
    }
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    New-VHD -Path $VhdPath -Dynamic -SizeBytes ($VhdSizeGB * 1GB) | Out-Null
    Attach-WorkspaceVhd
  }
  'Attach' {
    Attach-WorkspaceVhd
  }
  'InstallBootTask' {
    if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
      throw "VHD does not exist: $VhdPath"
    }
    $quotedScript = '"{0}"' -f $PSCommandPath
    $quotedVhd = '"{0}"' -f $VhdPath
    $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedScript -Mode Attach -VhdPath $quotedVhd"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
    Register-ScheduledTask -TaskName $BootTaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Output "Installed boot task '$BootTaskName'. The WSL bootstrap must still mount by UUID before runner services start."
  }
  'Compact' {
    if (-not $ConfirmIdle) {
      throw 'Compaction requires -ConfirmIdle after runner services and Runner.Worker processes have been stopped.'
    }
    $image = Get-DiskImage -ImagePath $VhdPath -ErrorAction SilentlyContinue
    if ($image -and $image.Attached) {
      throw 'Refusing to compact an attached VHD. Stop WSL runner services, unmount it, and detach the VHD first.'
    }
    Optimize-VHD -Path $VhdPath -Mode Full
    Write-Output "Compacted detached VHD $VhdPath. Reattach only after the runner workspace bootstrap is ready."
  }
}

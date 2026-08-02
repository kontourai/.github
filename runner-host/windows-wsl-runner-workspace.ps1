[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Provision', 'Attach', 'AttachAndBootstrap', 'InstallBootTask', 'Compact')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$VhdPath,

  [ValidateRange(1, 65536)]
  [int]$VhdSizeGB = 48,

  [ValidateNotNullOrEmpty()]
  [string]$DistroName = 'Ubuntu',

  [string]$WslBootstrapCommand,

  [ValidateNotNullOrEmpty()]
  [string]$BootTaskName = 'Kontour WSL runner workspace VHD attach',

  [switch]$ConfirmIdle,

  [switch]$ConfirmDetached
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
  & wsl.exe --mount $VhdPath --vhd --bare
  if ($LASTEXITCODE -ne 0) {
    throw "WSL failed to attach VHD $VhdPath. Refusing to guess whether an existing attachment is safe."
  }
  Write-Output "Attached VHD $VhdPath to WSL. Mount it only from the $DistroName UUID bootstrap path."
}

function Invoke-WslBootstrap {
  if ([string]::IsNullOrWhiteSpace($WslBootstrapCommand) -or $WslBootstrapCommand.Contains("`n") -or $WslBootstrapCommand.Contains("`r")) {
    throw 'AttachAndBootstrap requires a single-line WslBootstrapCommand that mounts by UUID, binds runner paths, and starts services.'
  }
  & wsl.exe --distribution $DistroName --user root -- bash -lc $WslBootstrapCommand
  if ($LASTEXITCODE -ne 0) {
    throw "WSL bootstrap failed for distribution $DistroName. Runner services were not started."
  }
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
  'AttachAndBootstrap' {
    Attach-WorkspaceVhd
    Invoke-WslBootstrap
  }
  'InstallBootTask' {
    if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
      throw "VHD does not exist: $VhdPath"
    }
    if ([string]::IsNullOrWhiteSpace($WslBootstrapCommand)) {
      throw 'InstallBootTask requires WslBootstrapCommand so every boot mounts by UUID and starts runner services.'
    }
    $quote = { param([string]$value) "'" + $value.Replace("'", "''") + "'" }
    $quotedScript = & $quote $PSCommandPath
    $quotedVhd = & $quote $VhdPath
    $quotedDistro = & $quote $DistroName
    $quotedBootstrap = & $quote $WslBootstrapCommand
    $command = "& $quotedScript -Mode AttachAndBootstrap -VhdPath $quotedVhd -DistroName $quotedDistro -WslBootstrapCommand $quotedBootstrap"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
    Register-ScheduledTask -TaskName $BootTaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Output "Installed boot task '$BootTaskName'. It attaches through WSL, runs the UUID bootstrap, and starts runner services only after mounts succeed."
  }
  'Compact' {
    if (-not $ConfirmIdle -or -not $ConfirmDetached) {
      throw 'Compaction requires -ConfirmIdle and -ConfirmDetached after runner services and Runner.Worker processes have been stopped and WSL has detached the VHD.'
    }
    Optimize-VHD -Path $VhdPath -Mode Full
    Write-Output "Compacted declared-detached VHD $VhdPath. Reattach only after the runner workspace bootstrap is ready."
  }
}

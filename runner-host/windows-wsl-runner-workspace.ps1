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

  [ValidateNotNullOrEmpty()]
  [string]$WslWindowsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name,

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
  param([switch]$AllowAlreadyAttached)
  if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
    throw "VHD does not exist: $VhdPath"
  }
  & wsl.exe --mount $VhdPath --vhd --bare
  if ($LASTEXITCODE -ne 0) {
    if (-not $AllowAlreadyAttached) {
      throw "WSL failed to attach VHD $VhdPath. Refusing to guess whether an existing attachment is safe."
    }
    return $false
  }
  Write-Output "Attached VHD $VhdPath to WSL. Mount it only from the $DistroName UUID bootstrap path."
  return $true
}

function Invoke-WslBootstrap {
  if ([string]::IsNullOrWhiteSpace($WslBootstrapCommand) -or $WslBootstrapCommand.Contains("`n") -or $WslBootstrapCommand.Contains("`r") -or $WslBootstrapCommand -notmatch '--uuid\s+[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}') {
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
    $newAttachment = Attach-WorkspaceVhd -AllowAlreadyAttached
    Invoke-WslBootstrap
    if (-not $newAttachment) {
      Write-Output 'WSL reported an existing VHD attachment; UUID bootstrap validated it before services were started.'
    }
  }
  'InstallBootTask' {
    if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
      throw "VHD does not exist: $VhdPath"
    }
    if ([string]::IsNullOrWhiteSpace($WslBootstrapCommand)) {
      throw 'InstallBootTask requires WslBootstrapCommand so every boot mounts by UUID and starts runner services.'
    }
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($WslWindowsUser -ne $currentUser) {
      throw "Run InstallBootTask elevated as the WSL-owning user $WslWindowsUser; the current user $currentUser cannot safely validate another user's distro registration."
    }
    $registeredDistros = & wsl.exe --list --quiet
    if ($LASTEXITCODE -ne 0 -or -not ($registeredDistros | Where-Object { $_.Trim() -eq $DistroName })) {
      throw "WSL distribution $DistroName is not registered for Windows user $WslWindowsUser."
    }
    $quote = { param([string]$value) "'" + $value.Replace("'", "''") + "'" }
    $quotedScript = & $quote $PSCommandPath
    $quotedVhd = & $quote $VhdPath
    $quotedDistro = & $quote $DistroName
    $quotedUser = & $quote $WslWindowsUser
    $quotedBootstrap = & $quote $WslBootstrapCommand
    $command = "& $quotedScript -Mode AttachAndBootstrap -VhdPath $quotedVhd -DistroName $quotedDistro -WslWindowsUser $quotedUser -WslBootstrapCommand $quotedBootstrap"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $bootTrigger = New-ScheduledTaskTrigger -AtStartup
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $WslWindowsUser
    $principal = New-ScheduledTaskPrincipal -UserId $WslWindowsUser -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $BootTaskName -Action $action -Trigger @($bootTrigger, $logonTrigger) -Principal $principal -Force | Out-Null
    Write-Output "Installed task '$BootTaskName' for WSL user $WslWindowsUser. The logon trigger is authoritative; the boot trigger runs only when Windows has a usable interactive token."
  }
  'Compact' {
    if (-not $ConfirmIdle -or -not $ConfirmDetached) {
      throw 'Compaction requires -ConfirmIdle and -ConfirmDetached after runner services and Runner.Worker processes have been stopped and WSL has detached the VHD.'
    }
    Optimize-VHD -Path $VhdPath -Mode Full
    Write-Output "Compacted declared-detached VHD $VhdPath. Reattach only after the runner workspace bootstrap is ready."
  }
}

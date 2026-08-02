[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Provision', 'Attach', 'AttachAndBootstrap', 'AttachBootstrapAndKeepAlive', 'InstallBootTask', 'Compact')]
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

  [ValidateNotNullOrEmpty()]
  [string]$TaskEntrypointPath = "$env:ProgramData\Kontour\runner-host\windows-wsl-runner-workspace.ps1",

  [switch]$ConfirmDrainActive,

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

function Invoke-WslKeepAlive {
  # `tail -f /dev/null` is intentionally blocking: Scheduled Tasks owns this
  # process so WSL cannot immediately idle-shutdown after the bootstrap exits.
  & wsl.exe --distribution $DistroName --user root --exec /bin/sh -lc 'exec tail -f /dev/null'
  if ($LASTEXITCODE -ne 0) {
    throw "WSL keepalive exited unexpectedly for distribution $DistroName."
  }
}

function Install-ProtectedTaskEntrypoint {
  if ([string]::IsNullOrWhiteSpace($PSCommandPath) -or -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
    throw 'InstallBootTask must be run from a saved script file so it can install a protected entrypoint copy.'
  }
  if (-not [IO.Path]::IsPathRooted($TaskEntrypointPath)) {
    throw 'TaskEntrypointPath must be an absolute Windows path.'
  }
  if ((Test-Path -LiteralPath $TaskEntrypointPath) -and (Get-Item -LiteralPath $TaskEntrypointPath).PSIsContainer) {
    throw "TaskEntrypointPath is a directory: $TaskEntrypointPath"
  }
  if ((Test-Path -LiteralPath $TaskEntrypointPath) -and ((Get-Item -LiteralPath $TaskEntrypointPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "TaskEntrypointPath may not be a reparse point: $TaskEntrypointPath"
  }
  $entrypointDirectory = Split-Path -Parent $TaskEntrypointPath
  if ([string]::IsNullOrWhiteSpace($entrypointDirectory)) {
    throw 'TaskEntrypointPath must include a parent directory.'
  }
  New-Item -ItemType Directory -Path $entrypointDirectory -Force | Out-Null
  if (((Get-Item -LiteralPath $entrypointDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "TaskEntrypointPath parent may not be a reparse point: $entrypointDirectory"
  }
  Copy-Item -LiteralPath $PSCommandPath -Destination $TaskEntrypointPath -Force

  $administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($protectedPath in @($entrypointDirectory, $TaskEntrypointPath)) {
    $inheritance = if ((Get-Item -LiteralPath $protectedPath).PSIsContainer) { $inherit } else { [Security.AccessControl.InheritanceFlags]::None }
    $acl = Get-Acl -LiteralPath $protectedPath
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
    $acl.SetOwner($administrators)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administrators, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $protectedPath -AclObject $acl
  }

  foreach ($protectedPath in @($entrypointDirectory, $TaskEntrypointPath)) {
    $verifiedAcl = Get-Acl -LiteralPath $protectedPath
    $owner = [Security.Principal.SecurityIdentifier]::new($verifiedAcl.Owner)
    if (-not $verifiedAcl.AreAccessRulesProtected -or $owner.Value -ne $administrators.Value) {
      throw "Protected task entrypoint ACL verification failed for $protectedPath."
    }
    $writeSids = $verifiedAcl.Access | Where-Object {
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0
    } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($administrators.Value -notin $writeSids -or $system.Value -notin $writeSids) {
      throw "Protected task entrypoint is missing administrator or SYSTEM write access: $protectedPath."
    }
    $unexpectedWrite = $verifiedAcl.Access | Where-Object {
      $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
      $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -notin @($administrators, $system) -and
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0
    }
    if ($unexpectedWrite) {
      throw "Protected task entrypoint has unexpected write access: $protectedPath."
    }
  }
  return $TaskEntrypointPath
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
  'AttachBootstrapAndKeepAlive' {
    $newAttachment = Attach-WorkspaceVhd -AllowAlreadyAttached
    Invoke-WslBootstrap
    if (-not $newAttachment) {
      Write-Output 'WSL reported an existing VHD attachment; UUID bootstrap validated it before services were started.'
    }
    Invoke-WslKeepAlive
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
    $protectedEntrypoint = Install-ProtectedTaskEntrypoint
    $quote = { param([string]$value) "'" + $value.Replace("'", "''") + "'" }
    $quotedScript = & $quote $protectedEntrypoint
    $quotedVhd = & $quote $VhdPath
    $quotedDistro = & $quote $DistroName
    $quotedUser = & $quote $WslWindowsUser
    $quotedBootstrap = & $quote $WslBootstrapCommand
    $command = "& $quotedScript -Mode AttachBootstrapAndKeepAlive -VhdPath $quotedVhd -DistroName $quotedDistro -WslWindowsUser $quotedUser -WslBootstrapCommand $quotedBootstrap"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $bootTrigger = New-ScheduledTaskTrigger -AtStartup
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $WslWindowsUser
    $principal = New-ScheduledTaskPrincipal -UserId $WslWindowsUser -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $BootTaskName -Action $action -Trigger @($bootTrigger, $logonTrigger) -Principal $principal -Settings $settings -Force | Out-Null
    Write-Output "Installed task '$BootTaskName' for interactive WSL owner $WslWindowsUser. It keeps WSL alive until stopped, restarts after failure, and ignores concurrent trigger instances. The logon trigger is authoritative; the boot trigger runs only when Windows has a usable interactive token."
  }
  'Compact' {
    if (-not $ConfirmDrainActive -or -not $ConfirmDetached) {
      throw 'Compaction requires -ConfirmDrainActive and -ConfirmDetached after a persisted maintenance drain has stopped runner services and WSL has detached the VHD.'
    }
    Optimize-VHD -Path $VhdPath -Mode Full
    Write-Output "Compacted declared-detached VHD $VhdPath. Reattach only after the runner workspace bootstrap is ready."
  }
}

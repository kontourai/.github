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

  [string]$WslBootstrapScript,

  [string]$WslHealthScript,

  [string]$WslUuid,

  [string]$WslMountRoot,

  [string[]]$WslBind = @(),

  [string]$WslHealthIncidentPath,

  [ValidateRange(1, 86400)]
  [int]$WslHealthTimeoutSeconds = 30,

  [ValidateRange(1, 86400)]
  [int]$WslHealthIntervalSeconds = 60,

  [string[]]$RunnerService = @(),

  [string]$WslConfigurationBase64,

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

function Assert-WslCanonicalPath {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Description)
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^/' -or $Path.Contains("`n") -or $Path.Contains("`r") -or ($Path.Split('/') | Where-Object { $_ -in @('.', '..') })) {
    throw "$Description must be a canonical absolute Linux path without traversal."
  }
}

function Assert-WslCanonicalRootOwnedScript {
  param([Parameter(Mandatory = $true)][string]$ScriptPath)
  Assert-WslCanonicalPath -Path $ScriptPath -Description 'WSL script path'
  $resolvedPath = (& wsl.exe --distribution $DistroName --user root --exec /usr/bin/readlink -f -- $ScriptPath | Select-Object -First 1).Trim()
  if ($LASTEXITCODE -ne 0 -or $resolvedPath -ne $ScriptPath) {
    throw "WSL script path is not canonical or resolves through a link: $ScriptPath"
  }
  $currentPath = $ScriptPath
  while ($true) {
    $metadata = (& wsl.exe --distribution $DistroName --user root --exec /usr/bin/stat "--format=%U|%a|%F" -- $currentPath | Select-Object -First 1).Trim()
    if ($LASTEXITCODE -ne 0 -or $metadata -notmatch '^(?<owner>[^|]+)\|(?<mode>[0-7]+)\|(?<kind>.+)$') {
      throw "Could not verify WSL script metadata: $currentPath"
    }
    $mode = [Convert]::ToInt32($Matches.mode, 8)
    if ($Matches.owner -ne 'root' -or ($mode -band 18) -ne 0) {
      throw "WSL script ancestry must be root-owned and not group- or world-writable: $currentPath"
    }
    if ($currentPath -eq $ScriptPath -and ($Matches.kind -ne 'regular file' -or ($mode -band 64) -eq 0)) {
      throw "WSL script must be a root-owned, executable regular file: $ScriptPath"
    }
    if ($currentPath -eq '/') { break }
    $lastSlash = $currentPath.LastIndexOf('/')
    $currentPath = if ($lastSlash -eq 0) { '/' } else { $currentPath.Substring(0, $lastSlash) }
  }
}

function Import-WslOperationalConfiguration {
  if ([string]::IsNullOrWhiteSpace($WslConfigurationBase64)) { return }
  try {
    $configurationJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($WslConfigurationBase64))
    $configuration = $configurationJson | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw 'WslConfigurationBase64 must contain valid UTF-8 JSON configuration.'
  }
  foreach ($property in @('WslBootstrapScript', 'WslHealthScript', 'WslUuid', 'WslMountRoot', 'WslHealthIncidentPath', 'WslHealthTimeoutSeconds', 'WslHealthIntervalSeconds', 'WslBind', 'RunnerService')) {
    if ($null -eq $configuration.PSObject.Properties[$property]) {
      throw "WslConfigurationBase64 is missing required property: $property"
    }
  }
  Set-Variable -Scope Script -Name WslBootstrapScript -Value ([string]$configuration.WslBootstrapScript)
  Set-Variable -Scope Script -Name WslHealthScript -Value ([string]$configuration.WslHealthScript)
  Set-Variable -Scope Script -Name WslUuid -Value ([string]$configuration.WslUuid)
  Set-Variable -Scope Script -Name WslMountRoot -Value ([string]$configuration.WslMountRoot)
  Set-Variable -Scope Script -Name WslHealthIncidentPath -Value ([string]$configuration.WslHealthIncidentPath)
  Set-Variable -Scope Script -Name WslHealthTimeoutSeconds -Value ([int]$configuration.WslHealthTimeoutSeconds)
  Set-Variable -Scope Script -Name WslHealthIntervalSeconds -Value ([int]$configuration.WslHealthIntervalSeconds)
  Set-Variable -Scope Script -Name WslBind -Value @($configuration.WslBind | ForEach-Object { [string]$_ })
  Set-Variable -Scope Script -Name RunnerService -Value @($configuration.RunnerService | ForEach-Object { [string]$_ })
}

function Assert-WslOperationalConfiguration {
  Import-WslOperationalConfiguration
  if ([string]::IsNullOrWhiteSpace($WslUuid) -or $WslUuid -notmatch '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$') {
    throw 'Runner startup requires WslUuid in canonical UUID form.'
  }
  if ($WslHealthTimeoutSeconds -lt 1 -or $WslHealthTimeoutSeconds -gt 86400 -or $WslHealthIntervalSeconds -lt 1 -or $WslHealthIntervalSeconds -gt 86400) {
    throw 'Runner startup requires health timeout and interval values between 1 and 86400 seconds.'
  }
  Assert-WslCanonicalPath -Path $WslMountRoot -Description 'WslMountRoot'
  Assert-WslCanonicalPath -Path $WslHealthIncidentPath -Description 'WslHealthIncidentPath'
  if ($WslBind.Count -eq 0 -or $RunnerService.Count -eq 0) {
    throw 'Runner startup requires at least one WslBind and RunnerService.'
  }
  foreach ($binding in $WslBind) {
    if ($binding -notmatch '^(?<source>/[^:]+):(?<target>/[^:]+)$') { throw "WslBind must be canonical absolute SOURCE:TARGET: $binding" }
    Assert-WslCanonicalPath -Path $Matches.source -Description 'WslBind source'
    Assert-WslCanonicalPath -Path $Matches.target -Description 'WslBind target'
  }
  foreach ($service in $RunnerService) {
    if ($service -notmatch '^[A-Za-z0-9@_.:-]+\.service$') { throw "RunnerService must be a simple .service unit name: $service" }
  }
  Assert-WslCanonicalRootOwnedScript -ScriptPath $WslBootstrapScript
  Assert-WslCanonicalRootOwnedScript -ScriptPath $WslHealthScript
}

function Invoke-WslBootstrap {
  $arguments = @('--distribution', $DistroName, '--user', 'root', '--exec', $WslBootstrapScript, '--uuid', $WslUuid, '--mount-root', $WslMountRoot)
  foreach ($binding in $WslBind) { $arguments += @('--bind', $binding) }
  $arguments += @('--health-script', $WslHealthScript, '--health-incident-path', $WslHealthIncidentPath, '--health-timeout-seconds', "$WslHealthTimeoutSeconds")
  foreach ($service in $RunnerService) { $arguments += @('--service', $service) }
  & wsl.exe @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "WSL bootstrap failed for distribution $DistroName. Runner services were not started."
  }
}

function Invoke-WslContainment {
  $arguments = @('--distribution', $DistroName, '--user', 'root', '--exec', $WslHealthScript, 'contain', '--probe-path', $WslMountRoot, '--incident-path', $WslHealthIncidentPath, '--timeout-seconds', "$WslHealthTimeoutSeconds")
  foreach ($service in $RunnerService) { $arguments += @('--service', $service) }
  & wsl.exe @arguments
  return $LASTEXITCODE -eq 0
}

function Invoke-WslKeepAlive {
  $arguments = @('--distribution', $DistroName, '--user', 'root', '--exec', $WslHealthScript, 'watch', '--probe-path', $WslMountRoot, '--incident-path', $WslHealthIncidentPath, '--timeout-seconds', "$WslHealthTimeoutSeconds", '--interval-seconds', "$WslHealthIntervalSeconds")
  foreach ($service in $RunnerService) { $arguments += @('--service', $service) }
  & wsl.exe @arguments
  $watchExitCode = $LASTEXITCODE
  if (-not (Invoke-WslContainment)) {
    throw "CRITICAL: WSL health watcher returned unexpectedly for distribution $DistroName with exit code $watchExitCode, and trusted stop-and-mask containment also failed. Do not start runners or re-enable the scheduled task."
  }
  throw "WSL health watcher returned unexpectedly for distribution $DistroName with exit code $watchExitCode; trusted stop-and-mask containment was invoked."
}

function Set-AndAssertProtectedAcl {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][bool]$IsDirectory)
  $administrators = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $system = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $inheritance = if ($IsDirectory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $acl.SetOwner($administrators)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($administrators, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $Path -AclObject $acl

  $verifiedAcl = Get-Acl -LiteralPath $Path
  $owner = $verifiedAcl.GetOwner([Security.Principal.SecurityIdentifier])
  if (-not $verifiedAcl.AreAccessRulesProtected -or $owner.Value -ne $administrators.Value) {
    throw "Protected task entrypoint ACL verification failed for $Path."
  }
  $writeSids = $verifiedAcl.Access | Where-Object {
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0
  } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($administrators.Value -notin $writeSids -or $system.Value -notin $writeSids) {
    throw "Protected task entrypoint is missing administrator or SYSTEM write access: $Path."
  }
  if ($writeSids | Where-Object { $_ -notin @($administrators.Value, $system.Value) }) {
    throw "Protected task entrypoint has unexpected write access: $Path."
  }
}

function Install-ProtectedTaskEntrypoint {
  if ([string]::IsNullOrWhiteSpace($PSCommandPath) -or -not (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
    throw 'InstallBootTask must be run from a saved script file so it can install a protected entrypoint copy.'
  }
  $programData = Get-Item -LiteralPath $env:ProgramData -Force
  if ($programData.PSIsContainer -ne $true -or ($programData.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'ProgramData must be a real, non-reparse directory.'
  }
  $programDataPath = [IO.Path]::GetFullPath($programData.FullName).TrimEnd('\')
  $entrypointPath = [IO.Path]::GetFullPath($TaskEntrypointPath)
  if ($TaskEntrypointPath -ne $entrypointPath) {
    throw 'TaskEntrypointPath must be a canonical Windows path without traversal.'
  }
  if (-not $entrypointPath.StartsWith("$programDataPath\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'TaskEntrypointPath must be canonically under the real ProgramData directory.'
  }
  $relativePath = $entrypointPath.Substring($programDataPath.Length + 1)
  $segments = $relativePath.Split('\')
  if ($segments.Count -lt 2 -or ($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -in @('.', '..') })) {
    throw 'TaskEntrypointPath must name a file below a protected ProgramData subdirectory.'
  }
  $sourceHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
  $currentDirectory = $programDataPath
  foreach ($segment in $segments[0..($segments.Count - 2)]) {
    $currentDirectory = Join-Path $currentDirectory $segment
    if (-not (Test-Path -LiteralPath $currentDirectory)) { New-Item -ItemType Directory -Path $currentDirectory | Out-Null }
    $directoryItem = Get-Item -LiteralPath $currentDirectory -Force
    if (-not $directoryItem.PSIsContainer -or ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [IO.Path]::GetFullPath($directoryItem.FullName) -ne $currentDirectory) {
      throw "ProgramData task-entrypoint ancestry is unsafe: $currentDirectory"
    }
    Set-AndAssertProtectedAcl -Path $currentDirectory -IsDirectory $true
  }
  if ((Test-Path -LiteralPath $entrypointPath) -and ((Get-Item -LiteralPath $entrypointPath -Force).PSIsContainer -or ((Get-Item -LiteralPath $entrypointPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) {
    throw "TaskEntrypointPath is not a regular file target: $entrypointPath"
  }
  Copy-Item -LiteralPath $PSCommandPath -Destination $entrypointPath -Force
  $entrypointItem = Get-Item -LiteralPath $entrypointPath -Force
  if ($entrypointItem.PSIsContainer -or ($entrypointItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or [IO.Path]::GetFullPath($entrypointItem.FullName) -ne $entrypointPath) {
    throw "Protected task entrypoint identity verification failed: $entrypointPath"
  }
  Set-AndAssertProtectedAcl -Path $entrypointPath -IsDirectory $false
  $installedHash = (Get-FileHash -LiteralPath $entrypointPath -Algorithm SHA256).Hash
  if ($installedHash -ne $sourceHash) { throw "Protected task entrypoint hash verification failed: $entrypointPath" }
  return $entrypointPath
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
    Assert-WslOperationalConfiguration
    $newAttachment = Attach-WorkspaceVhd -AllowAlreadyAttached
    Invoke-WslBootstrap
    if (-not $newAttachment) {
      Write-Output 'WSL reported an existing VHD attachment; UUID bootstrap validated it before services were started.'
    }
  }
  'AttachBootstrapAndKeepAlive' {
    Assert-WslOperationalConfiguration
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
    Assert-WslOperationalConfiguration
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
    $wslConfiguration = [ordered]@{
      WslBootstrapScript = $WslBootstrapScript
      WslHealthScript = $WslHealthScript
      WslUuid = $WslUuid
      WslMountRoot = $WslMountRoot
      WslBind = @($WslBind)
      WslHealthIncidentPath = $WslHealthIncidentPath
      WslHealthTimeoutSeconds = $WslHealthTimeoutSeconds
      WslHealthIntervalSeconds = $WslHealthIntervalSeconds
      RunnerService = @($RunnerService)
    }
    $wslConfigurationBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($wslConfiguration | ConvertTo-Json -Compress)))
    $quotedConfiguration = & $quote $wslConfigurationBase64
    $command = "& $quotedScript -Mode AttachBootstrapAndKeepAlive -VhdPath $quotedVhd -DistroName $quotedDistro -WslWindowsUser $quotedUser -WslConfigurationBase64 $quotedConfiguration"
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

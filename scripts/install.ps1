# Pastor's installer for Windows. It downloads the Windows release, checks its sha256, lays it down,
# and puts `pastor` on your user PATH. It is the Windows twin of install.sh.
#
# Run it like this, in PowerShell:
#
#   irm https://raw.githubusercontent.com/Ad3Digital/pastor/main/scripts/install.ps1 | iex
#
# You can also download this file, read it, and run it by hand:
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Windows marks a file that a browser downloaded (the Mark of the Web), and a RemoteSigned policy then
# refuses it as "not digitally signed". After you have read it, clear the mark with:
#
#   Unblock-File .\install.ps1
#
# This file is one page with no helpers to fetch, so you can read all of it before you run it.
# What it will never do:
#   - It never asks for admin rights.
#   - It never writes outside PASTOR_DIR, except one entry in your user PATH.
#   - It never starts a service or a task. It runs one program once: the new pastor.exe, as
#     `pastor.exe version`, to check that Windows lets it run.
#   - It never sends anything anywhere. It only downloads the release files.
#   - It never installs a download whose sha256 does not match. There is no flag to skip the check.
# It ends by PRINTING the next steps. It never takes them for you.
#
# It needs no toolchain: no Bun, no Git, no bash. It needs Windows 10 build 19041 or newer on x64,
# and Windows PowerShell 5.1 or PowerShell 7. Pastor on Windows is experimental, and pastor.exe is
# not signed. The sha256 check is the only check that the download is the one the release published.
#
# Three environment variables steer what it installs:
#   PASTOR_DIR          where to install. Default: %LOCALAPPDATA%\pastor
#   PASTOR_UPDATE_REPO  which GitHub repository to download from. Default: Ad3Digital/pastor
#   PASTOR_TAG          install one exact release tag, for example v1.16.0. A pin skips the tag
#                       lookup, so the script makes no call to api.github.com.
# A GitHub token in PASTOR_GITHUB_TOKEN, GH_TOKEN or GITHUB_TOKEN goes only to api.github.com, with
# the one call that lists the tags. It never goes with a download and never to a mirror.
# Two more exist on Windows only, and neither is in install.sh:
#   PASTOR_NO_PATH_EDIT=1     do not change the user PATH. Run <PASTOR_DIR>\current\bin\pastor.exe.
#   PASTOR_INSTALL_MIRROR     A TEST SEAM for tests and rehearsals, not a way to install. A base URL
#                             that replaces https://api.github.com and https://github.com. Only a
#                             file:/// URL or http://127.0.0.1 or http://localhost (with a port) is
#                             accepted, and a loud line says it is set. The script asks it for
#                             /repos/<repo>/tags and /<repo>/releases/download/<tag>/<file>.
#
# The layout is the one `pastor update` reads: <PASTOR_DIR>\versions\<X.Y.Z> holds one release, and
# <PASTOR_DIR>\current is a directory junction to one of them. A standard user can make a junction.
# A symbolic link needs Developer Mode, so this uses none.
#
# Everything is inside functions, and the last line calls them. If the download of this file stops
# half way, `iex` gets no last line, and nothing runs. A failed run ends with a line that starts
# "Install failed." and names one fix, and sets $LASTEXITCODE: 0 when it installed, 1 when it failed.
# Run as a file (`powershell -File install.ps1`), a failure also ends with `exit 1`, which ends only
# that PowerShell. Under `irm | iex` it never calls `exit`, because that would close your window.

# Stop the install. What happened, then the one thing to do about it. The entry function prints both,
# with "Install failed." in front of the fix, as the last line.
function Stop-PastorInstall([string]$What, [string]$Fix = "Corrija o problema acima e rode o instalador de novo.") {
  $failure = New-Object System.Exception $What
  $failure.Data["PastorFix"] = $Fix
  throw $failure
}

# The messages are Portuguese, but this file must stay plain ASCII (Windows PowerShell 5.1 reads a
# file with no byte-order mark as the ANSI code page). So an accented letter is written as an
# entity such as &#xE7; and turned back into the letter here, just before it is printed.
# Operators and casts only, no .NET call: it also prints the refusal under Constrained Language Mode.
function ConvertFrom-PastorText([string]$Text) {
  $out = $Text
  while ($out -cmatch '\A(?s).*?&#x([0-9A-Fa-f]{2,4});') {
    $hex = $Matches[1]
    $out = $out -creplace "&#x$hex;", [string][char][int]"0x$hex"
  }
  return $out
}

function Write-PastorLine([string]$Text) {
  Write-Host (ConvertFrom-PastorText $Text)
}

# Is this machine one Pastor publishes a binary for? Returns the reason it is not, or $null.
function Get-PastorHostProblem([string]$Arch, [int]$Build) {
  if ($Arch -ne "AMD64" -and $Arch -ne "X64") {
    return "o Pastor n&#xE3;o publica bin&#xE1;rio do Windows para $Arch. S&#xF3; existe para x64 (AMD64)."
  }
  if ($Build -lt 19041) {
    return "este Windows &#xE9; o build $Build. O Pastor precisa do Windows 10 build 19041 ou mais novo, e &#xE9; testado no Windows 11."
  }
  return $null
}

# The processor of the machine, not of this PowerShell. A 32-bit PowerShell on 64-bit Windows says x86.
function Get-PastorArch {
  try {
    $os = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($null -ne $os) { return $os.ToString() }
  } catch { }
  if ($env:PROCESSOR_ARCHITEW6432) { return $env:PROCESSOR_ARCHITEW6432 }
  return $env:PROCESSOR_ARCHITECTURE
}

# Every value that becomes part of a URL or a path is checked here first, case-sensitively and
# anchored at both ends (\A and \z: `$` would let a trailing newline through). A tag the API or a
# mirror returns is checked the same way as one you typed, so a hostile answer such as
# `v1.0.0\..\..\x` never reaches a path.
function Test-PastorTag([string]$Tag, [switch]$AllowPrerelease) {
  if ($AllowPrerelease) { return $Tag -cmatch '\Av[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?\z' }
  return $Tag -cmatch '\Av[0-9]+\.[0-9]+\.[0-9]+\z'
}

# owner/name, each part from [A-Za-z0-9._-] and not made of dots alone.
function Test-PastorRepo([string]$Repo) {
  if ($Repo -cnotmatch '\A([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+)\z') { return $false }
  return ($Matches[1] -cnotmatch '\A\.+\z') -and ($Matches[2] -cnotmatch '\A\.+\z')
}

# Why Path cannot be the install folder, or $null. It must be a full path on a drive, not a share and
# not the drive itself, and hold no `;` or `%`: the folder goes into your PATH, where `;` splits an
# entry and `%` starts a variable. A space, `&` or a non-ASCII letter is fine.
function Get-PastorDirProblem([string]$Path) {
  if ($Path -cnotmatch '\A[A-Za-z]:[\\/]') { return "PASTOR_DIR='$Path' n&#xE3;o &#xE9; um caminho completo num disco, como C:\Users\voce\pastor" }
  if ($Path.Contains(';') -or $Path.Contains('%')) { return "PASTOR_DIR='$Path' tem um ';' ou um '%', que quebraria o seu PATH" }
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full -cmatch '\A[A-Za-z]:\z') { return "PASTOR_DIR='$Path' &#xE9; a raiz de um disco" }
  return $null
}

# The strict release tags (vX.Y.Z), newest first, compared as numbers (v1.15.0 is newer than v1.9.0).
# A prerelease is never picked: pin it.
function Sort-PastorTags([string[]]$Names) {
  return @($Names | Where-Object { Test-PastorTag $_ } | Sort-Object { [version]$_.Substring(1) } -Descending)
}

# Check a downloaded file against its sidecar line "<sha256>  <name>" (the name may be left out).
# Returns the problem, or $null.
function Get-PastorDigestProblem([string]$Sidecar, [string]$Name, [string]$Actual) {
  $words = @("$Sidecar".Trim() -split '\s+')
  if ($words.Count -gt 2 -or $words[0] -cnotmatch '\A[0-9a-fA-F]{64}\z') {
    return "$Name.sha256 n&#xE3;o &#xE9; uma linha '<sha256>  <nome>'"
  }
  if ($words.Count -eq 2 -and $words[1].TrimStart('*') -cne $Name) { return "$Name.sha256 indica $($words[1]), e n&#xE3;o $Name" }
  if (-not [string]::Equals($words[0], $Actual, [StringComparison]::OrdinalIgnoreCase)) {
    return "CHECKSUM DIFERENTE em $Name"
  }
  return $null
}

# The user PATH with Entry added at the end, or $null when it is there already. Pure, so it is tested
# with strings. The value keeps every byte it had: no entry is reordered, expanded or dropped.
function Add-PastorUserPathEntry([string]$PathValue, [string]$Entry) {
  $want = $Entry.TrimEnd('\')
  foreach ($part in ("$PathValue" -split ';')) {
    if ($part -eq '') { continue }
    $expanded = [Environment]::ExpandEnvironmentVariables($part).TrimEnd('\')
    if ($part.TrimEnd('\') -eq $want -or $expanded -eq $want) { return $null }
  }
  if ("$PathValue" -eq '') { return $Entry }
  # A value that ends in ';' keeps ending in ';', so removing the entry again (the line `pastor
  # uninstall` prints) gives back the exact value it had before.
  if ("$PathValue".EndsWith(';')) { return "$PathValue$Entry;" }
  return "$PathValue;$Entry"
}

# Add Entry to HKCU\Environment\Path. No admin is needed. Returns $true when it changed the value.
function Set-PastorUserPath([string]$Entry) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
  try {
    $raw = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($null -ne $key.GetValue("Path")) { $kind = $key.GetValueKind("Path") }
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
      Stop-PastorInstall "o PATH do seu usu&#xE1;rio est&#xE1; gravado como $kind, que este script n&#xE3;o edita." "Adicione $Entry ao PATH do seu usu&#xE1;rio &#xE0; m&#xE3;o, ou defina PASTOR_NO_PATH_EDIT=1 e rode o instalador de novo."
    }
    $new = Add-PastorUserPathEntry $raw $Entry
    if ($null -eq $new) { return $false }
    $key.SetValue("Path", $new, $kind)
  } finally {
    $key.Close()
  }
  # Tell open programs that the environment changed, so a terminal started from the Start menu sees
  # the new PATH. .NET sends that message after any user variable change. Removing a variable that
  # does not exist changes nothing in the registry, and still sends the message.
  [Environment]::SetEnvironmentVariable("PASTOR_INSTALL_NOT_A_VARIABLE", $null, "User")
  return $true
}

# The HTTP status of a failed web call, or 0 when no server answered.
function Get-PastorHttpCode($ErrorRecord) {
  $response = $ErrorRecord.Exception.Response
  if ($null -eq $response) { return 0 }
  try { return [int]$response.StatusCode } catch { return 0 }
}

# Is Url a mirror this script accepts? Only a local folder or this machine's loopback address.
function Test-PastorMirror([string]$Url) {
  return $Url -cmatch '\A(file:///[A-Za-z]:/[A-Za-z0-9._~/ -]*|http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?)\z'
}

# Download Url to OutFile. Returns 200, the HTTP status of a failure, or 0 when no server answered.
# A file:/// URL (a mirror folder) is copied, and a missing file answers 404.
function Get-PastorFile([string]$Url, [string]$OutFile) {
  if ($Url.StartsWith("file:///")) {
    $local = ([Uri]$Url).LocalPath
    if (-not (Test-Path -LiteralPath $local -PathType Leaf)) { return 404 }
    Copy-Item -LiteralPath $local -Destination $OutFile
    return 200
  }
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -ErrorAction Stop
    return 200
  } catch {
    Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
    return (Get-PastorHttpCode $_)
  }
}

# Why a zip entry may not be unpacked, or $null. Every entry must sit under Root/, with no drive, no
# stream (':'), no leading slash and no '..' part. This is what stops a zip that writes outside the
# folder it is unpacked into.
function Get-PastorEntryProblem([string]$Name, [string]$Root) {
  if ($Name -ceq '') { return "uma entrada sem nome" }
  if ($Name.Contains(':')) { return "'$Name' indica um disco ou um fluxo alternativo" }
  if ($Name.StartsWith('/') -or $Name.StartsWith('\')) { return "'$Name' come&#xE7;a na raiz" }
  if (@($Name -split '[\\/]' | Where-Object { $_ -ceq '..' }).Count -gt 0) { return "'$Name' sai da pasta com '..'" }
  if (-not $Name.StartsWith("$Root/", [StringComparison]::Ordinal)) { return "'$Name' n&#xE3;o est&#xE1; dentro de $Root/" }
  return $null
}

# Unpack Zip into Destination, one entry at a time, after EVERY entry has been checked: by name, and
# by its full path, which must start with Destination\. Nothing is written when one entry fails.
# System.IO.Compression is part of Windows; nothing is compiled.
function Expand-PastorZip([string]$Zip, [string]$Destination, [string]$Root) {
  try { Add-Type -AssemblyName System.IO.Compression.FileSystem } catch { }
  $dest = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    $plan = New-Object System.Collections.ArrayList
    foreach ($entry in $archive.Entries) {
      $problem = Get-PastorEntryProblem $entry.FullName $Root
      if ($null -eq $problem) {
        $target = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($dest, $entry.FullName.Replace('/', '\')))
        if (-not $target.StartsWith($dest, [StringComparison]::OrdinalIgnoreCase)) { $problem = "'$($entry.FullName)' aponta para fora da pasta" }
      }
      if ($null -ne $problem) { Stop-PastorInstall "o zip n&#xE3;o &#xE9; seguro para descompactar: $problem. Nada foi instalado." "Avise em https://github.com/Ad3Digital/pastor/issues" }
      [void]$plan.Add(@($entry, $target))
    }
    foreach ($item in $plan) {
      $entry = $item[0]; $target = $item[1]
      if ($entry.FullName.EndsWith('/')) { [void][System.IO.Directory]::CreateDirectory($target); continue }
      [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target))
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
  } finally {
    $archive.Dispose()
  }
}

# A rename that tries again while the folder is busy. Defender often holds a new folder for a moment.
function Move-PastorItem([string]$From, [string]$To) {
  for ($try = 1; ; $try++) {
    try {
      [System.IO.Directory]::Move($From, $To)
      return
    } catch {
      if ($try -ge 5) { throw }
      Start-Sleep -Milliseconds (500 * $try)
    }
  }
}

# "absent", "link" (a junction or a symbolic link) or "other". It never follows the link.
function Get-PastorLinkState([string]$Path) {
  try {
    $attributes = [System.IO.File]::GetAttributes($Path)
  } catch {
    return "absent"
  }
  if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { return "link" }
  return "other"
}

function Get-PastorLinkTarget([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $target = @($item.Target)
  if ($target.Count -eq 0 -or "$($target[0])" -eq '') { return $null }
  return "$($target[0])"
}

function New-PastorJunction([string]$Path, [string]$Target) {
  New-Item -ItemType Junction -Path $Path -Value $Target -ErrorAction Stop | Out-Null
}

# Remove a junction ITSELF. A non-recursive delete never touches the folder the junction names.
function Remove-PastorLink([string]$Path) {
  if ([System.IO.File]::GetAttributes($Path) -band [System.IO.FileAttributes]::Directory) { [System.IO.Directory]::Delete($Path, $false) }
  else { [System.IO.File]::Delete($Path) }
}

# Delete a folder this script made, and everything in it. It never follows a junction or a link: one
# found anywhere in the tree is removed by itself, so the folder it names keeps every file. That is
# why this script has no `Remove-Item -Recurse`, which in Windows PowerShell 5.1 walks into one.
function Remove-PastorTree([string]$Path) {
  $state = Get-PastorLinkState $Path
  if ($state -eq "absent") { return }
  if ($state -eq "link") { Remove-PastorLink $Path; return }
  if (-not ([System.IO.File]::GetAttributes($Path) -band [System.IO.FileAttributes]::Directory)) {
    [System.IO.File]::SetAttributes($Path, [System.IO.FileAttributes]::Normal)
    [System.IO.File]::Delete($Path)
    return
  }
  foreach ($child in [System.IO.Directory]::GetFileSystemEntries($Path)) { Remove-PastorTree $child }
  [System.IO.Directory]::Delete($Path, $false)
}

# Delete Path only when it is an EMPTY real folder.
function Remove-PastorEmptyFolder([string]$Path) {
  if ((Get-PastorLinkState $Path) -ne "other") { return }
  if (@([System.IO.Directory]::GetFileSystemEntries($Path)).Count -gt 0) { return }
  [System.IO.Directory]::Delete($Path, $false)
}

# Point <Dir>\current at Target. A new junction is made beside it first, which proves the folder can
# be named before anything moves. Then the old junction goes and the new one takes its name. When
# that fails, the old junction is put back, or the exact command to put it back is printed.
function Set-PastorCurrent([string]$Dir, [string]$Target) {
  $current = Join-Path $Dir "current"
  $staged = Join-Path $Dir ".current.new"
  $state = Get-PastorLinkState $current
  if ($state -eq "absent") {
    New-PastorJunction $current $Target
    return
  }
  if ($state -eq "other") {
    Stop-PastorInstall "$current &#xE9; uma pasta ou arquivo de verdade, n&#xE3;o uma jun&#xE7;&#xE3;o, ent&#xE3;o o Pastor n&#xE3;o pode remov&#xEA;-lo." "Tire $current do lugar e rode o instalador de novo."
  }
  $old = Get-PastorLinkTarget $current
  switch (Get-PastorLinkState $staged) {
    "link" { Remove-PastorLink $staged }
    "other" { Stop-PastorInstall "$staged est&#xE1; no caminho e n&#xE3;o &#xE9; uma jun&#xE7;&#xE3;o." "Tire $staged do lugar e rode o instalador de novo." }
  }
  New-PastorJunction $staged $Target
  try {
    Remove-PastorLink $current
    Move-PastorItem $staged $current
    return
  } catch {
    $why = $_.Exception.Message
  }
  if ((Get-PastorLinkState $staged) -eq "link") { try { Remove-PastorLink $staged } catch { } }
  if ($null -ne $old -and (Get-PastorLinkState $current) -eq "absent") {
    try {
      New-PastorJunction $current $old
    } catch {
      Stop-PastorInstall "n&#xE3;o deu para apontar $current para $Target ($why). $current sumiu, e recoloc&#xE1;-lo tamb&#xE9;m falhou." "Crie de novo &#xE0; m&#xE3;o:  cmd /c mklink /J `"$current`" `"$old`""
    }
  }
  Stop-PastorInstall "n&#xE3;o deu para apontar $current para $Target ($why). $current continua apontando para $old. Nada foi alterado." "Feche todo programa que roda o Pastor de $Dir e rode o instalador de novo."
}

# Stop a process and every process below it, children first, so none is left without a parent to
# be found by. Windows PowerShell 5.1 has no Kill(entireProcessTree), and taskkill would be a second
# program this script runs.
function Stop-PastorTree([int]$Id) {
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $Id" -ErrorAction SilentlyContinue)) {
    Stop-PastorTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue
}

# Run Exe once, as `Exe version`, and wait up to 30 seconds. Returns $null when it ran and exited 0,
# or what went wrong. cmd.exe writes its output to Log, a file: nothing is read through a pipe, which
# a program left running could hold open. Its input is NUL, so nothing waits for a key. On the
# timeout the whole tree goes (Stop-PastorTree): killing cmd.exe alone left a hung pastor.exe
# running, and it held the version folder open.
function Test-PastorRuns([string]$Exe, [string]$Log) {
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return "$Exe n&#xE3;o existe" }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path ([Environment]::SystemDirectory) "cmd.exe"
  $start.Arguments = "/d /s /c `"`"$Exe`" version < NUL > `"$Log`" 2>&1`""
  $start.UseShellExecute = $false
  $run = [System.Diagnostics.Process]::Start($start)
  if (-not $run.WaitForExit(30000)) {
    Stop-PastorTree $run.Id
    [void]$run.WaitForExit(5000)
    return "pastor.exe version n&#xE3;o terminou em 30 segundos"
  }
  if ($run.ExitCode -eq 0) { return $null }
  $said = ""
  if (Test-Path -LiteralPath $Log) { $said = "$(@([System.IO.File]::ReadAllLines($Log) | Where-Object { $_.Trim() -ne '' })[0])".Trim() }
  return "pastor.exe version parou com o c&#xF3;digo de sa&#xED;da $($run.ExitCode): $said"
}

# The one message for a pastor.exe that Windows did not let run. The files stay where they are.
function Stop-PastorBlocked([string]$Dir, [string]$Exe, [string]$Why) {
  Stop-PastorInstall ("o Pastor foi instalado em $Dir, mas o Windows n&#xE3;o deixou o pastor.exe rodar ($Why). " +
    "As causas comuns s&#xE3;o o Controle Inteligente de Aplicativos, o Microsoft Defender (ele pode ter colocado o arquivo em quarentena) ou uma pol&#xED;tica de quem administra este computador. " +
    "A instala&#xE7;&#xE3;o pode ficar onde est&#xE1;. O Controle Inteligente de Aplicativos n&#xE3;o abre exce&#xE7;&#xE3;o para um programa, e deslig&#xE1;-lo &#xE9; definitivo, ent&#xE3;o decida isso antes. " +
    "Se apareceu 'O Windows protegeu o computador' (SmartScreen), clique em Mais informa&#xE7;&#xF5;es e depois em Executar assim mesmo.") "Resolva a causa e rode  `"$Exe`" version  para conferir. Se travar, avise em https://github.com/Ad3Digital/pastor/issues"
}

# Add the PATH entry, unless PASTOR_NO_PATH_EDIT says no. Returns one line that says what happened.
function Publish-PastorName([string]$Dir) {
  $bin = Join-Path $Dir "current\bin"
  if ($env:PASTOR_NO_PATH_EDIT -eq "1") {
    return "PASTOR_NO_PATH_EDIT=1 est&#xE1; definido, ent&#xE3;o o seu PATH n&#xE3;o foi alterado. Rode o Pastor como $bin\pastor.exe."
  }
  $added = Set-PastorUserPath $bin
  # This window too, so the steps below work here without a new terminal. Appended, like the user PATH.
  $here = Add-PastorUserPathEntry $env:Path $bin
  if ($null -ne $here) { $env:Path = $here }
  if ($added) { return "$bin foi adicionado ao PATH do seu usu&#xE1;rio." }
  return "$bin j&#xE1; estava no PATH do seu usu&#xE1;rio."
}

# How to spell Pastor in the printed steps: `pastor` when that name finds THIS install's pastor.exe,
# else the full path (no PATH edit, or another `pastor` comes first on PATH).
function Get-PastorCommandName([string]$Exe) {
  $found = Get-Command pastor -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $found -and [string]::Equals($found.Source, $Exe, [StringComparison]::OrdinalIgnoreCase)) { return "pastor" }
  return $Exe
}

function Invoke-PastorInstall {
  $repo = "$env:PASTOR_UPDATE_REPO".Trim()
  if ($repo -eq '') { $repo = "Ad3Digital/pastor" }
  if (-not (Test-PastorRepo $repo)) {
    Stop-PastorInstall "PASTOR_UPDATE_REPO='$repo' n&#xE3;o &#xE9; um nome de reposit&#xF3;rio do GitHub como Ad3Digital/pastor." "Defina PASTOR_UPDATE_REPO como dono/nome, ou remova para usar as vers&#xF5;es do pr&#xF3;prio Pastor."
  }
  if ($repo -cne "Ad3Digital/pastor") {
    Write-PastorLine "AVISO: PASTOR_UPDATE_REPO est&#xE1; definido. Isto instala o Pastor de github.com/$repo, n&#xE3;o de Ad3Digital/pastor."
  }
  $dir = "$env:PASTOR_DIR".Trim()
  if ($dir -eq '') {
    if ("$env:LOCALAPPDATA" -eq '') { Stop-PastorInstall "LOCALAPPDATA n&#xE3;o est&#xE1; definido." "Defina PASTOR_DIR com a pasta onde instalar e rode o instalador de novo." }
    $dir = Join-Path $env:LOCALAPPDATA "pastor"
  }
  $problem = Get-PastorDirProblem $dir
  if ($null -ne $problem) { Stop-PastorInstall "$problem." "Defina PASTOR_DIR com o caminho completo de uma pasta, como C:\Users\voce\pastor, e rode o instalador de novo." }
  $dir = [System.IO.Path]::GetFullPath($dir).TrimEnd('\')
  $mirror = "$env:PASTOR_INSTALL_MIRROR".Trim().TrimEnd('/')
  if ($mirror -ne '') {
    if (-not (Test-PastorMirror $mirror)) {
      Stop-PastorInstall "PASTOR_INSTALL_MIRROR='$mirror' n&#xE3;o &#xE9; uma URL file:/// nem http://127.0.0.1 ou http://localhost. Serve s&#xF3; para testes, nunca como fonte de download." "Remova PASTOR_INSTALL_MIRROR para instalar do GitHub."
    }
    Write-PastorLine "AVISO: PASTOR_INSTALL_MIRROR est&#xE1; definido. Isto &#xE9; s&#xF3; para testes: tudo vem de $mirror, n&#xE3;o do GitHub."
  }

  # A pinned tag is checked before anything is fetched or touched.
  $pin = "$env:PASTOR_TAG".Trim()
  if ($pin -ne '' -and -not (Test-PastorTag $pin -AllowPrerelease)) {
    Stop-PastorInstall "PASTOR_TAG='$pin' n&#xE3;o &#xE9; uma tag de vers&#xE3;o." "Defina PASTOR_TAG com uma tag como v1.16.0 (ou v1.16.0-rc.1), ou remova para pegar a vers&#xE3;o mais nova."
  }

  $problem = Get-PastorHostProblem (Get-PastorArch) ([Environment]::OSVersion.Version.Build)
  if ($null -ne $problem) { Stop-PastorInstall $problem "Instale o Pastor numa m&#xE1;quina x64 com Windows 10 build 19041 ou mais novo." }

  # Leave an existing install alone, unless a tag was pinned. A pin lays that version down BESIDE
  # what is there and points `current` at it. That is the way back when the installed version is
  # the broken one.
  $rescue = $false
  if (Test-Path -LiteralPath $dir) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { Stop-PastorInstall "$dir &#xE9; um arquivo." "Tire $dir do lugar, ou defina PASTOR_DIR com outra pasta." }
    $isGit = Test-Path -LiteralPath (Join-Path $dir ".git")
    $hasVersions = Test-Path -LiteralPath (Join-Path $dir "versions") -PathType Container
    if ($isGit -and $pin -ne '') {
      Stop-PastorInstall "$dir &#xE9; um checkout do git, e PASTOR_TAG s&#xF3; fixa a vers&#xE3;o de uma instala&#xE7;&#xE3;o bin&#xE1;ria." "Fixe a vers&#xE3;o pelo git:  git -C $dir checkout $pin"
    }
    if ($hasVersions -and -not $isGit -and $pin -ne '') {
      $rescue = $true
    } elseif ($isGit -or $hasVersions) {
      # A rerun is not an update: `pastor update` owns that, so a working `current` is never moved
      # from here without a pin, and nothing is changed or downloaded.
      $installed = "Pastor"
      if ($isGit) { $installed = "Pastor (checkout do git)" }
      else {
        $target = Get-PastorLinkTarget (Join-Path $dir "current")
        if ($null -ne $target) { $installed = "Pastor " + [System.IO.Path]::GetFileName($target.TrimEnd('\')) }
      }
      Write-PastorLine "$installed j&#xE1; est&#xE1; instalado em $dir. Para atualizar, rode: pastor update"
      Write-PastorLine "Para instalar uma vers&#xE3;o exata ao lado, defina PASTOR_TAG (por exemplo `$env:PASTOR_TAG = 'v1.16.0') e rode o instalador de novo."
      return
    } else {
      $other = @(Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -ne ".staging" })
      if ($other.Count -gt 0) { Stop-PastorInstall "$dir j&#xE1; existe e n&#xE3;o &#xE9; uma instala&#xE7;&#xE3;o do Pastor." "Tire $dir do lugar, ou defina PASTOR_DIR com outra pasta." }
    }
  }

  # Which release. The tags are the list `pastor update` reads too, never `releases/latest`. A
  # GitHub token, if you have one, goes with this ONE call to api.github.com: never with a download
  # (Windows PowerShell 5.1 can carry the header across the redirect to the file host) and never to
  # a mirror. Without a pin, the newest strict tag is tried first, then up to four older ones,
  # because a release made before Pastor shipped a Windows zip has none.
  $platform = "windows-x64"
  $releases = "https://github.com/$repo/releases"
  $candidates = @($pin)
  if ($pin -eq '') {
    $api = if ($mirror -ne '') { $mirror } else { "https://api.github.com" }
    $headers = @{ Accept = "application/vnd.github+json" }
    $tokenFrom = ''
    foreach ($name in "PASTOR_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN") {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ("$value" -ne '') { $tokenFrom = $name; break }
    }
    if ($tokenFrom -ne '' -and $mirror -eq '') { $headers.Authorization = "Bearer " + [Environment]::GetEnvironmentVariable($tokenFrom) }
    $pinFix = "diga a vers&#xE3;o e pule esta consulta:  `$env:PASTOR_TAG = 'vX.Y.Z'  (as tags est&#xE3;o em $releases)"
    try {
      if ($api.StartsWith("file:///")) {
        $tagsFile = ([Uri]"$api/repos/$repo/tags").LocalPath
        if (-not (Test-Path -LiteralPath $tagsFile -PathType Leaf)) { Stop-PastorInstall "o espelho n&#xE3;o tem $tagsFile." "Coloque a lista de tags l&#xE1;, ou remova PASTOR_INSTALL_MIRROR." }
        $rows = @([System.IO.File]::ReadAllText($tagsFile) | ConvertFrom-Json | ForEach-Object { $_ })
      } else {
        # Every page: GitHub serves 100 tags a page, and a newer tag can sit on a later one. A page
        # shorter than 100 is the last; ten pages is the bound, as in `pastor update`.
        $rows = @()
        for ($page = 1; $page -le 10; $page++) {
          $uri = "$api/repos/$repo/tags?per_page=100"
          if ($page -gt 1) { $uri = "$uri&page=$page" }
          $answer = Invoke-WebRequest -UseBasicParsing -Uri $uri -Headers $headers -ErrorAction Stop
          $onePage = @($answer.Content | ConvertFrom-Json | ForEach-Object { $_ })
          $rows += $onePage
          if ($onePage.Count -lt 100) { break }
        }
      }
    } catch {
      if ($null -ne $_.Exception.Data["PastorFix"]) { throw }
      $code = Get-PastorHttpCode $_
      if ($code -eq 0) { Stop-PastorInstall "n&#xE3;o deu para acessar $api para listar as vers&#xF5;es." "Confira a sua internet, ou $pinFix" }
      if ($code -eq 401 -and $headers.ContainsKey("Authorization")) { Stop-PastorInstall "o GitHub recusou o token em $tokenFrom (HTTP 401)." "Corrija ou remova $tokenFrom e rode o instalador de novo." }
      if ($code -eq 403 -or $code -eq 429) {
        Stop-PastorInstall "o limite de consultas da API do GitHub foi atingido (HTTP $code). Sem token o GitHub permite 60 consultas por hora por endere&#xE7;o de rede." "Espere uma hora, defina GH_TOKEN com um token do GitHub sem permiss&#xF5;es, ou $pinFix"
      }
      Stop-PastorInstall "$api respondeu HTTP $code ao pedir as tags de $repo." "Tente de novo mais tarde, ou $pinFix"
    }
    $names = @($rows | ForEach-Object { "$($_.name)" })
    $candidates = @(Sort-PastorTags $names | Select-Object -First 5)
    if ($candidates.Count -eq 0) { Stop-PastorInstall "nenhuma tag de vers&#xE3;o encontrada para $repo." "Fixe uma vers&#xE3;o com PASTOR_TAG, ou avise em https://github.com/Ad3Digital/pastor/issues" }
  }
  $current = Join-Path $dir "current"

  # The pinned version may be on disk already: then the rescue is a junction flip and nothing more.
  if ($rescue) {
    $tag = $pin
    $versionDir = Join-Path $dir "versions\$($tag.Substring(1))"
  }
  if ($rescue) {
    foreach ($folder in (Join-Path $dir "versions"), $versionDir) {
      if ((Get-PastorLinkState $folder) -eq "link") {
        Stop-PastorInstall "$folder &#xE9; uma jun&#xE7;&#xE3;o ou um link, n&#xE3;o uma pasta criada por este instalador." "Tire $folder do lugar e rode o instalador de novo."
      }
    }
    if ((Get-PastorLinkState $current) -eq "other") {
      Stop-PastorInstall "$current &#xE9; uma pasta ou arquivo de verdade, n&#xE3;o uma jun&#xE7;&#xE3;o, ent&#xE3;o o Pastor n&#xE3;o pode remov&#xEA;-lo." "Tire $current do lugar e rode o instalador de novo."
    }
  }
  if ($rescue -and (Test-Path -LiteralPath $versionDir)) {
    # A folder from a move that stopped half way is not an install: it must hold bin\pastor.exe.
    if (-not (Test-Path -LiteralPath (Join-Path $versionDir "bin\pastor.exe"))) {
      Stop-PastorInstall "$versionDir existe mas n&#xE3;o tem bin\pastor.exe." "Tire $versionDir do lugar e rode o instalador de novo."
    }
    $now = Get-PastorLinkTarget $current
    if ($null -ne $now -and $now.TrimEnd('\') -eq $versionDir) {
      Write-PastorLine (Publish-PastorName $dir)
      Write-PastorLine "OK  O Pastor $tag est&#xE1; instalado em $dir e current j&#xE1; aponta para ele. Nada foi alterado nem baixado."
      return
    }
    Set-PastorCurrent $dir $versionDir
    Write-PastorLine (Publish-PastorName $dir)
    $blocked = Test-PastorRuns (Join-Path $current "bin\pastor.exe") (Join-Path $dir ".pastor-version-check.txt")
    Remove-Item -LiteralPath (Join-Path $dir ".pastor-version-check.txt") -Force -ErrorAction SilentlyContinue
    if ($null -ne $blocked) { Stop-PastorBlocked $dir (Join-Path $current "bin\pastor.exe") $blocked }
    Write-PastorLine "OK  O Pastor $tag j&#xE1; estava em $versionDir. current agora aponta para ele, e nada foi baixado."
    Write-PastorLine "Se o Pastor estiver rodando, rode  pastor restart  para usar esta vers&#xE3;o."
    return
  }

  # Download, and verify before anything is unpacked. The scratch folder is inside PASTOR_DIR, and
  # it is removed on every way out.
  if ($rescue) { Write-PastorLine "O Pastor j&#xE1; est&#xE1; instalado em $dir. Instalando $pin ao lado e apontando current para ela." }
  $createdDir = -not (Test-Path -LiteralPath $dir)
  $staging = Join-Path $dir ".staging"
  $work = Join-Path $staging "install-$PID"
  try {
    # A `.staging` left by a run that was stopped is emptied. One that is a junction is removed by
    # itself (the folder it names is not touched), and a real folder takes its place.
    switch (Get-PastorLinkState $staging) {
      "link" { Remove-PastorLink $staging }
      "other" { foreach ($leftover in [System.IO.Directory]::GetFileSystemEntries($staging)) { Remove-PastorTree $leftover } }
    }
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    # The checksum file first: it is small, and a release with no Windows build has none.
    $tag = $null
    foreach ($candidate in $candidates) {
      $zipName = "pastor-$($candidate.Substring(1))-$platform.zip"
      $base = if ($mirror -ne '') { "$mirror/$repo/releases/download/$candidate" } else { "$releases/download/$candidate" }
      $code = Get-PastorFile "$base/$zipName.sha256" (Join-Path $work "$zipName.sha256")
      if ($code -eq 0) { Stop-PastorInstall "n&#xE3;o deu para acessar o download de $candidate." "Confira a sua internet e rode o instalador de novo." }
      if ($code -eq 200) { $tag = $candidate; break }
      if ($pin -ne '') {
        Stop-PastorInstall "a vers&#xE3;o $pin n&#xE3;o tem $zipName.sha256 (HTTP $code), ent&#xE3;o o download n&#xE3;o pode ser conferido. Ou essa vers&#xE3;o n&#xE3;o tem build para Windows, ou falta o arquivo de checksum. Nada foi instalado." "Confira a tag em $releases, ou fixe outra com PASTOR_TAG."
      }
      Write-PastorLine "$candidate n&#xE3;o tem build para Windows. Tentando a vers&#xE3;o anterior."
    }
    if ($null -eq $tag) {
      Stop-PastorInstall "nenhuma das $($candidates.Count) vers&#xF5;es mais novas de $repo tem build para Windows ainda. Nada foi instalado." "Fixe uma vers&#xE3;o que tenha:  `$env:PASTOR_TAG = 'vX.Y.Z'  (veja $releases)"
    }
    $version = $tag.Substring(1)
    $versionDir = Join-Path $dir "versions\$version"
    $zip = Join-Path $work $zipName
    if ($mirror -ne '') { Write-PastorLine "Baixando o Pastor $tag para $platform do espelho $mirror ..." }
    else { Write-PastorLine "Baixando o Pastor $tag para $platform ..." }
    $code = Get-PastorFile "$base/$zipName" $zip
    if ($code -eq 0) { Stop-PastorInstall "n&#xE3;o deu para acessar o download de $zipName." "Confira a sua internet e rode o instalador de novo." }
    if ($code -ne 200) {
      Stop-PastorInstall "a vers&#xE3;o $tag tem arquivo de checksum mas n&#xE3;o tem $zipName (HTTP $code). Nada foi instalado." "Tente de novo mais tarde. Se acontecer de novo, avise em https://github.com/Ad3Digital/pastor/issues"
    }
    $manifestPath = Join-Path $work "manifest.json"
    if ((Get-PastorFile "$base/pastor-$version.manifest.json" $manifestPath) -ne 200) {
      Stop-PastorInstall "n&#xE3;o deu para baixar o manifesto da vers&#xE3;o $version. Nada foi instalado." "Tente de novo mais tarde. Se acontecer de novo, avise em https://github.com/Ad3Digital/pastor/issues"
    }
    $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1) {
      Stop-PastorInstall "a vers&#xE3;o $version usa um manifesto que este instalador n&#xE3;o entende." "Avise em https://github.com/Ad3Digital/pastor/issues"
    }
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    $problem = Get-PastorDigestProblem ([System.IO.File]::ReadAllText("$zip.sha256")) $zipName $digest
    if ($null -ne $problem) {
      Stop-PastorInstall "$problem. O download foi descartado e nada foi instalado." "Rode o instalador de novo. Se acontecer de novo, avise em https://github.com/Ad3Digital/pastor/issues"
    }
    # The manifest's own Windows entry, matched by platform, and its digest compared as a whole value.
    $entries = @($manifest.artifacts | Where-Object { "$($_.platform)" -ceq $platform })
    $named = ($entries.Count -eq 1) -and ("$($entries[0].name)" -ceq $zipName) -and [string]::Equals("$($entries[0].sha256)", $digest, [StringComparison]::OrdinalIgnoreCase)
    if (-not $named) { Stop-PastorInstall "o hash de $zipName n&#xE3;o &#xE9; o que o manifesto da vers&#xE3;o $version indica. Nada foi instalado." "Avise em https://github.com/Ad3Digital/pastor/issues" }

    # Lay it down: one complete payload per version, and `current` names one of them.
    $unpacked = Join-Path $work "unpacked"
    Expand-PastorZip $zip $unpacked "pastor-$version-$platform"
    $payload = Join-Path $unpacked "pastor-$version-$platform"
    if (-not (Test-Path -LiteralPath (Join-Path $payload "bin\pastor.exe"))) {
      Stop-PastorInstall "$zipName n&#xE3;o cont&#xE9;m bin\pastor.exe. A instala&#xE7;&#xE3;o foi recusada." "Avise em https://github.com/Ad3Digital/pastor/issues"
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $dir "versions") | Out-Null
    if ((Get-PastorLinkState (Join-Path $dir "versions")) -ne "other") { Stop-PastorInstall "$dir\versions &#xE9; uma jun&#xE7;&#xE3;o ou um link, n&#xE3;o uma pasta criada por este instalador." "Tire $dir\versions do lugar e rode o instalador de novo." }
    if ((Get-PastorLinkState $versionDir) -ne "absent") { Stop-PastorInstall "$versionDir j&#xE1; existe." "Tire $versionDir do lugar e rode o instalador de novo." }
    try { Move-PastorItem $payload $versionDir }
    catch { Stop-PastorInstall "n&#xE3;o deu para mover os arquivos para $versionDir ($($_.Exception.Message))." "Feche programas que possam estar usando arquivos em $dir (um antiv&#xED;rus pode) e rode o instalador de novo." }
    Set-PastorCurrent $dir $versionDir
  } finally {
    try { Remove-PastorTree $work } catch { }
    try { Remove-PastorEmptyFolder $staging } catch { }
    if ($createdDir) { try { Remove-PastorEmptyFolder $dir } catch { } }
  }

  $published = Publish-PastorName $dir
  $exe = Join-Path $current "bin\pastor.exe"
  # The check file sits in PASTOR_DIR, like everything else this script writes.
  $check = Join-Path $dir ".pastor-version-check.txt"
  $blocked = Test-PastorRuns $exe $check
  Remove-Item -LiteralPath $check -Force -ErrorAction SilentlyContinue
  if ($null -ne $blocked) {
    Write-PastorLine $published
    Stop-PastorBlocked $dir $exe $blocked
  }
  $pastor = Get-PastorCommandName $exe
  $herdr = Get-Command herdr -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  # The Herdr app's own core, where its installer puts it. Pastor shows the terminals of either Herdr.
  $herdrApp = $null
  if ($env:LOCALAPPDATA) {
    $core = Join-Path $env:LOCALAPPDATA "Programs\herdr-core\herdr-core.exe"
    if (Test-Path -LiteralPath $core -PathType Leaf) { $herdrApp = $core }
  }

  # A pinned run over an install: Pastor may be running already, so the next step is a restart,
  # as for a rescue that found the version on disk, never a first start.
  if ($rescue) {
    Write-PastorLine ""
    Write-PastorLine "OK  O Pastor $version est&#xE1; instalado em $dir, e current aponta para ele."
    Write-PastorLine "    O download confere com o checksum publicado na vers&#xE3;o, e o pastor.exe roda."
    Write-PastorLine $published
    Write-PastorLine "Se o Pastor estiver rodando, rode  $pastor restart  para usar esta vers&#xE3;o."
    return
  }

  # What is left is yours.
  Write-PastorLine ""
  Write-PastorLine "OK  O Pastor $version est&#xE1; instalado em $dir. Nada est&#xE1; rodando ainda."
  Write-PastorLine "    O download confere com o checksum publicado na vers&#xE3;o, e o pastor.exe roda."
  Write-PastorLine $published
  if ($null -ne $herdrApp) { Write-PastorLine "Herdr app encontrado: $herdrApp" }
  elseif ($null -ne $herdr) { Write-PastorLine "Herdr encontrado: $($herdr.Source)" }
  else { Write-PastorLine "O Herdr n&#xE3;o foi encontrado. O Pastor no Windows precisa dele (passo 2)." }
  Write-PastorLine ""
  Write-PastorLine "Pr&#xF3;ximos passos. Este script n&#xE3;o faz por voc&#xEA;:"
  Write-PastorLine ""
  if ($env:PASTOR_NO_PATH_EDIT -eq "1") { Write-PastorLine "  1. Abra uma janela NOVA do terminal." }
  else { Write-PastorLine "  1. Abra uma janela NOVA do terminal. O Windows s&#xF3; entrega o PATH novo para janelas abertas depois desta instala&#xE7;&#xE3;o." }
  Write-PastorLine ""
  if ($null -ne $herdrApp) {
    Write-PastorLine "  2. Abra o Herdr app e deixe aberto, com o seu agente (Codex, Claude Code) numa aba."
    Write-PastorLine "     O Pastor mostra no celular os terminais que estiverem abertos nele."
  } elseif ($null -ne $herdr) {
    Write-PastorLine "  2. Abra o Herdr em outra janela do terminal e deixe rodando. O Pastor precisa dele antes de ligar."
    Write-PastorLine "       herdr"
  } else {
    Write-PastorLine "  2. Abra o Herdr app e deixe aberto. O Pastor precisa dele antes de ligar."
    Write-PastorLine "     Baixe o Herdr em https://herdr.dev e abra um agente (Codex, Claude Code) numa aba dele."
  }
  Write-PastorLine ""
  Write-PastorLine "  3. Ligue o Pastor e mostre o endere&#xE7;o dele:"
  Write-PastorLine "       $pastor start"
  Write-PastorLine "       $pastor url"
  Write-PastorLine "     No Windows, o Pastor s&#xF3; atende neste computador. Para abrir no celular, use a sua rede do"
  Write-PastorLine "     Tailscale (passo 5 do README): https://github.com/Ad3Digital/pastor#instalar-no-windows"
  Write-PastorLine ""
  Write-PastorLine "  4. Pareie o celular. O Pastor n&#xE3;o responde a nenhum aparelho at&#xE9; um ser pareado:"
  Write-PastorLine "       $pastor pair"
  Write-PastorLine ""
  Write-PastorLine "Ligar v&#xE1;rios computadores (crew) ainda n&#xE3;o funciona no Windows. O Pastor num computador s&#xF3; funciona normalmente."
  Write-PastorLine "O pastor.exe n&#xE3;o &#xE9; assinado: o Windows n&#xE3;o conhece quem publicou o arquivo. Se o Windows bloquear depois, rode  `"$exe`" version  para ver o motivo."
  Write-PastorLine "Leia $current\docs\security.md antes de abrir o Pastor no celular. O Pastor d&#xE1; acesso remoto ao terminal deste computador, de prop&#xF3;sito."
}

# Print a failure: what happened, then "Install failed." and the one fix, as the last line.
function Write-PastorFailure([string]$What, [string]$Fix) {
  Write-Host (ConvertFrom-PastorText "pastor install: $What") -ForegroundColor Red
  Write-Host (ConvertFrom-PastorText "A instala&#xE7;&#xE3;o falhou. $Fix") -ForegroundColor Red
}

# The install and its outcome. It sets $LASTEXITCODE (0 on success, 1 on a failure, 2 on an option)
# and puts back the one process-wide setting it changes (the TLS protocols), so nothing it did stays
# in your session.
function Invoke-PastorEntry([object[]]$Arguments) {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
    Write-PastorFailure "este PowerShell roda no modo $($ExecutionContext.SessionState.LanguageMode), e o instalador precisa do FullLanguage (uma pol&#xED;tica do aparelho define isso)." "Pe&#xE7;a a quem administra este computador, ou instale &#xE0; m&#xE3;o: https://github.com/Ad3Digital/pastor/blob/main/docs/install.md"
    $global:LASTEXITCODE = 1
    return
  }
  if (@($Arguments).Count -gt 0) {
    Write-PastorFailure "o install.ps1 n&#xE3;o aceita op&#xE7;&#xF5;es, e recebeu '$(@($Arguments)[0])'." "Rode sem op&#xE7;&#xF5;es. Ajuste com PASTOR_DIR, PASTOR_UPDATE_REPO e PASTOR_TAG."
    $global:LASTEXITCODE = 2
    return
  }
  $tls = [Net.ServicePointManager]::SecurityProtocol
  try {
    [Net.ServicePointManager]::SecurityProtocol = $tls -bor [Net.SecurityProtocolType]::Tls12
    Invoke-PastorInstall
    $global:LASTEXITCODE = 0
  } catch {
    $fix = $_.Exception.Data["PastorFix"]
    if ($null -eq $fix) { $fix = "Avise em https://github.com/Ad3Digital/pastor/issues com as linhas acima." }
    Write-PastorFailure $_.Exception.Message $fix
    $global:LASTEXITCODE = 1
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $tls
  }
}

# The entry. $PSCommandPath names the script file when it runs as one; under `irm | iex` it is empty.
# Only a file run ends a failure with `exit`: there it ends just that PowerShell and gives the caller
# the exit code. Under `iex` an `exit` would close your window, so the function returns instead.
function Install-Pastor([object[]]$Arguments) {
  Invoke-PastorEntry $Arguments
  if ($global:LASTEXITCODE -ne 0 -and "$PSCommandPath" -ne '') { exit $global:LASTEXITCODE }
}

Install-Pastor $args

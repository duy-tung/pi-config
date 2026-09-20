# Bootstrap Windows 10/11, PowerShell 5.1+; không cần Administrator.
$InstallerArguments = @($args)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-Download([string] $Url, [string] $Destination) {
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec 300
}

function Assert-Sha256([string] $File, [string] $Expected) {
    $Actual = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw "SHA256 không khớp: $File" }
}

function Get-GitBash {
    if ($env:PI_CONFIG_GIT_BASH) {
        if (!(Test-Path -LiteralPath $env:PI_CONFIG_GIT_BASH -PathType Leaf)) {
            throw 'PI_CONFIG_GIT_BASH không trỏ đến file Bash tồn tại.'
        }
        return $env:PI_CONFIG_GIT_BASH
    }
    $GitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($GitCommand) {
        $GitRoot = Split-Path (Split-Path $GitCommand.Source -Parent) -Parent
        foreach ($Relative in @('bin\bash.exe', 'usr\bin\bash.exe')) {
            $Candidate = Join-Path $GitRoot $Relative
            if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return $Candidate }
        }
    }
    return $null
}

$NodeVersion = '24.15.0'
$Architecture = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $Architecture = $env:PROCESSOR_ARCHITEW6432 }
switch ($Architecture.ToUpperInvariant()) {
    'ARM64' {
        $NodeArch = 'arm64'
        $NodeSha = 'c9eb7402eda26e2ba7e44b6727fc85a8de56c5095b1f71ebd3062892211aa116'
        $GitAsset = 'PortableGit-2.55.0.5-arm64.7z.exe'
        $GitSha = '49d1dd3158017fa9805d07268433dbab7021b2ec1c1cc3fbabaf8b8255764dd0'
    }
    'AMD64' {
        $NodeArch = 'x64'
        $NodeSha = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
        $GitAsset = 'PortableGit-2.55.0.5-64-bit.7z.exe'
        $GitSha = '5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290'
    }
    default { throw 'Chỉ hỗ trợ Windows x64 và ARM64.' }
}

$BootstrapDir = $env:PI_CONFIG_BOOTSTRAP_DIR
if (!$BootstrapDir) { $BootstrapDir = Join-Path $env:LOCALAPPDATA 'pi-config\bootstrap' }
$TaskTemp = Join-Path ([IO.Path]::GetTempPath()) ('pi-config-bootstrap-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TaskTemp | Out-Null
try {
    $NodeDir = Join-Path $BootstrapDir "node-v$NodeVersion-win-$NodeArch"
    $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $NodeExecutable = $null
    if ($env:PI_CONFIG_FRESH_TOOLCHAIN -ne '1' -and $NodeCommand -and (& $NodeCommand.Source --version) -eq "v$NodeVersion") {
        $NodeExecutable = $NodeCommand.Source
    }
    if (!$NodeExecutable) {
        $NodeExecutable = Join-Path $NodeDir 'node.exe'
        if (!(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
            if (Test-Path -LiteralPath $NodeDir) { throw "Toolchain chưa hoàn chỉnh: $NodeDir" }
            $ArchiveName = "node-v$NodeVersion-win-$NodeArch.zip"
            $ArchivePath = Join-Path $TaskTemp $ArchiveName
            Write-Host "Tải Node $NodeVersion (Windows/$NodeArch), kiểm SHA256..."
            Get-Download "https://nodejs.org/dist/v$NodeVersion/$ArchiveName" $ArchivePath
            Assert-Sha256 $ArchivePath $NodeSha
            Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TaskTemp
            New-Item -ItemType Directory -Path $BootstrapDir -Force | Out-Null
            Move-Item -LiteralPath (Join-Path $TaskTemp "node-v$NodeVersion-win-$NodeArch") -Destination $NodeDir
        }
        if ((& $NodeExecutable --version) -ne "v$NodeVersion") { throw 'Node toolchain không chạy đúng phiên bản.' }
    }
    $env:PATH = (Split-Path $NodeExecutable -Parent) + ';' + $env:PATH

    $GitBash = $null
    if ($env:PI_CONFIG_FRESH_TOOLCHAIN -ne '1') { $GitBash = Get-GitBash }
    if (!$GitBash) {
        $GitDir = Join-Path $BootstrapDir "git-2.55.0.5-$NodeArch"
        $GitBash = Join-Path $GitDir 'bin\bash.exe'
        if (!(Test-Path -LiteralPath $GitBash -PathType Leaf)) {
            if (Test-Path -LiteralPath $GitDir) { throw "Git portable chưa hoàn chỉnh: $GitDir" }
            $GitArchive = Join-Path $TaskTemp $GitAsset
            Write-Host 'Tải Git for Windows portable 2.55.0.5, kiểm SHA256...'
            Get-Download "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/$GitAsset" $GitArchive
            Assert-Sha256 $GitArchive $GitSha
            $GitStage = Join-Path $TaskTemp 'portable-git'
            & $GitArchive '-y' "-o$GitStage" | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Không giải nén được Git for Windows portable.' }
            if (!(Test-Path -LiteralPath (Join-Path $GitStage 'bin\bash.exe'))) { throw 'Git archive thiếu Bash.' }
            New-Item -ItemType Directory -Path $BootstrapDir -Force | Out-Null
            Move-Item -LiteralPath $GitStage -Destination $GitDir
        }
    }
    $env:PI_CONFIG_GIT_BASH = $GitBash
    $GitRoot = Split-Path (Split-Path $GitBash -Parent) -Parent
    if ((Split-Path $GitRoot -Leaf) -eq 'usr') { $GitRoot = Split-Path $GitRoot -Parent }
    $env:PATH = (Join-Path $GitRoot 'cmd') + ';' + (Join-Path $GitRoot 'usr\bin') + ';' + $env:PATH

    $SourceDir = $env:PI_CONFIG_SOURCE
    if (!$SourceDir) {
        $RepoRef = $env:PI_CONFIG_REF
        if (!$RepoRef) { $RepoRef = 'main' }
        if ($RepoRef -notmatch '^[A-Za-z0-9._/][A-Za-z0-9._/-]*$') { throw 'PI_CONFIG_REF không hợp lệ.' }
        Write-Host "Tải duy-tung/pi-config ($RepoRef)..."
        $RepoArchive = Join-Path $TaskTemp 'pi-config.zip'
        Get-Download "https://github.com/duy-tung/pi-config/archive/$RepoRef.zip" $RepoArchive
        $Extracted = Join-Path $TaskTemp 'source'
        Expand-Archive -LiteralPath $RepoArchive -DestinationPath $Extracted
        $Directories = @(Get-ChildItem -LiteralPath $Extracted -Directory)
        if ($Directories.Count -ne 1) { throw 'Cấu trúc repository archive không hợp lệ.' }
        $SourceDir = $Directories[0].FullName
    }
    $Installer = Join-Path $SourceDir 'install.mjs'
    if (!(Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "Không tìm thấy install.mjs trong $SourceDir" }
    & $NodeExecutable $Installer @InstallerArguments
    if ($LASTEXITCODE -ne 0) { throw "Installer thoát với mã $LASTEXITCODE." }
} finally {
    Remove-Item -LiteralPath $TaskTemp -Recurse -Force -ErrorAction SilentlyContinue
}

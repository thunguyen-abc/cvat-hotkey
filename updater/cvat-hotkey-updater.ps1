<#
.SYNOPSIS
  Trình cập nhật tự động cho CVAT Event Hotkeys (bản cài "Load unpacked" trên Windows).

.DESCRIPTION
  Kiểm tra GitHub Releases của thunguyen-abc/cvat-hotkey theo lịch, tải ZIP của bản mới,
  kiểm tra SHA-256 và nội dung ZIP, sao lưu bản đang dùng rồi ghi đè thư mục extension.
  Extension tự kích hoạt bản mới khi thấy manifest.json trên đĩa đổi phiên bản.

  Lệnh:
    setup      Cài lần đầu: chọn thư mục extension, chọn chế độ, tạo lịch chạy (mặc định).
    check      Kiểm tra và cài bản mới ngay.
    status     Xem cấu hình, lịch chạy và nhật ký gần nhất.
    rollback   Khôi phục bản sao lưu gần nhất.
    uninstall  Gỡ lịch chạy và dữ liệu của trình cập nhật (giữ nguyên extension).
    native     Chỉ dành cho Chrome/Edge (native messaging): nút "Cập nhật ngay" trong extension.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\cvat-hotkey-updater.ps1 setup
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'check', 'status', 'rollback', 'uninstall', 'native')]
  [string]$Command = 'setup',

  # Thư mục extension chứa manifest.json. Mặc định: thư mục cha của thư mục chứa script.
  [string]$ExtensionDir,

  # auto: tự cài bản mới. confirm: hỏi trước khi cài.
  [ValidateSet('auto', 'confirm')]
  [string]$Mode,

  [ValidateRange(1, 24)]
  [int]$IntervalHours = 3,

  # Dùng khi chạy từ Task Scheduler: hỏi bằng hộp thoại Windows thay vì console.
  [switch]$Scheduled,

  # Cài lại cả khi bản này đã bị bỏ qua trước đó.
  [switch]$Force,

  # Không hỏi xác nhận trên console (setup/rollback/uninstall).
  [switch]$Yes,

  # Người dùng đã bấm "Cập nhật ngay": không hỏi lại theo chế độ confirm. Vẫn hỏi nếu
  # bản mới xin thêm quyền.
  [switch]$Confirmed,

  # native: origin của extension gọi tới, do Chrome truyền vào.
  [string]$Origin
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repository = 'thunguyen-abc/cvat-hotkey'
$ExtensionName = 'CVAT Event Hotkeys'
$DataDir = if ($env:CVAT_HOTKEYS_UPDATER_HOME) { $env:CVAT_HOTKEYS_UPDATER_HOME } else { Join-Path $env:LOCALAPPDATA 'CVATEventHotkeys' }
$TaskName = if ($env:CVAT_HOTKEYS_UPDATER_HOME) { 'CVAT Event Hotkeys Updater (test)' } else { 'CVAT Event Hotkeys Updater' }
$ConfigPath = Join-Path $DataDir 'updater.json'
$LogPath = Join-Path $DataDir 'updater.log'
$InstalledScript = Join-Path $DataDir 'cvat-hotkey-updater.ps1'
$BackupRoot = Join-Path $DataDir 'backups'
$WorkRoot = Join-Path $DataDir 'work'
$StateFileName = 'updater-state.json'
$UpdaterEntry = 'updater/cvat-hotkey-updater.ps1'

# Native messaging: nút "Cập nhật ngay" trong popup gọi script này qua Chrome/Edge.
$NativeHostName = 'com.abcstudio.cvat_event_hotkeys'
$NativeHostManifest = Join-Path $DataDir "$NativeHostName.json"
$NativeHostCmd = Join-Path $DataDir 'native-host.cmd'
# Chế độ thử nghiệm chỉ đăng ký cho Chromium (dùng trong tests), không đụng Chrome/Edge thật.
$NativeRegistryRoots = if ($env:CVAT_HOTKEYS_UPDATER_HOME) {
  @('HKCU:\Software\Chromium\NativeMessagingHosts')
} else {
  @('HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts')
}
if ($Command -eq 'native') { $Scheduled = [switch]$true }  # stdout thuộc về giao thức native messaging

# Giới hạn và danh sách cho phép dùng khi kiểm tra bản phát hành.
$AllowedHosts = @('api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')
$AllowedExtensions = @('.js', '.css', '.html', '.json', '.md', '.txt', '.png', '.svg', '.ps1', '.cmd')
$ReservedNames = @('con', 'prn', 'aux', 'nul') + (1..9 | ForEach-Object { "com$_"; "lpt$_" })
$SafePathPattern = '^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$MaxZipBytes = 5MB
$MaxUnpackedBytes = 20MB
$MaxEntries = 200
$KeepBackups = 3

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

# ---------------------------------------------------------------- tiện ích chung

function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Write-Log([string]$Message, [string]$Level = 'INFO') {
  $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  if (-not $Scheduled) {
    $color = switch ($Level) { 'ERROR' { 'Red' } 'WARN' { 'Yellow' } default { 'Gray' } }
    Write-Host $Message -ForegroundColor $color
  }
  try {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt 256KB) {
      $tail = Get-Content -LiteralPath $LogPath -Tail 200 -Encoding UTF8
      Set-Content -LiteralPath $LogPath -Value $tail -Encoding UTF8
    }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # Không để lỗi ghi log làm hỏng lần cập nhật.
  }
}

function Write-Utf8File([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function Read-Config {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $config = [ordered]@{}
  foreach ($key in 'extensionDir', 'mode', 'intervalHours', 'installedFiles', 'skipVersion', 'lastCheck', 'lastResult', 'latestVersion',
      'extensionIds', 'allowedOrigins') {
    $config[$key] = Get-Prop $raw $key
  }
  if ($config.mode -notin @('auto', 'confirm')) { $config.mode = 'confirm' }
  if (-not $config.intervalHours) { $config.intervalHours = 3 }
  if ($config.installedFiles) { $config.installedFiles = @($config.installedFiles) }
  $config.extensionIds = @($config.extensionIds | Where-Object { $_ -match '^[a-p]{32}$' })
  $config.allowedOrigins = @($config.allowedOrigins | Where-Object { $_ })
  return $config
}

function Save-Config($Config) {
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  Write-Utf8File $ConfigPath ($Config | ConvertTo-Json -Depth 4)
}

function Write-UpdaterState($Config, [string]$Result, [string]$Message) {
  $Config.lastCheck = (Get-Date).ToString('o')
  $Config.lastResult = $Result
  try {
    $installed = (Get-ManifestFromDir $Config.extensionDir).version
    $state = [ordered]@{
      mode = $Config.mode
      intervalHours = $Config.intervalHours
      lastCheck = $Config.lastCheck
      result = $Result
      message = $Message
      installedVersion = $installed
      latestVersion = $Config.latestVersion
    }
    Write-Utf8File (Join-Path $Config.extensionDir $StateFileName) ($state | ConvertTo-Json)
  } catch {
    Write-Log "Không ghi được $StateFileName : $($_.Exception.Message)" 'WARN'
  }
}

function Assert-Version([string]$Value, [string]$Source) {
  if ($Value -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { throw "Phiên bản không hợp lệ trong $Source : '$Value'" }
}

function Get-ManifestFromDir([string]$Dir) {
  $path = Join-Path $Dir 'manifest.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Không thấy manifest.json trong $Dir" }
  $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-Version ([string](Get-Prop $manifest 'version')) $path
  return $manifest
}

function Resolve-ExtensionDir([string]$Path) {
  if (-not $Path) { throw 'Chưa chọn thư mục extension.' }
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) { throw "$Path không phải thư mục." }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "$Path là symlink/junction. Hãy chọn thư mục thật chứa extension."
  }
  $full = $item.FullName.TrimEnd('\')
  if (Test-Path -LiteralPath (Join-Path $full '.git')) {
    throw "$full là bản mã nguồn (git). Trình cập nhật không ghi đè thư mục phát triển."
  }
  $manifest = Get-ManifestFromDir $full
  if ((Get-Prop $manifest 'name') -ne $ExtensionName) {
    throw "manifest.json trong $full không phải của $ExtensionName."
  }
  return $full
}

function Test-SafeRelativePath([string]$Name) {
  if ($Name -notmatch $SafePathPattern) { return $false }
  foreach ($segment in $Name.Split('/')) {
    if ($ReservedNames -contains ($segment.Split('.')[0].ToLowerInvariant())) { return $false }
  }
  return $AllowedExtensions -contains ([IO.Path]::GetExtension($Name).ToLowerInvariant())
}

function Get-ExtensionFiles([string]$Dir) {
  # Chỉ các file có thể thuộc bản phát hành: tối đa một cấp thư mục con, đuôi được phép.
  $result = New-Object System.Collections.Generic.List[string]
  foreach ($file in Get-ChildItem -LiteralPath $Dir -File -Force) { $result.Add($file.Name) }
  foreach ($sub in Get-ChildItem -LiteralPath $Dir -Directory -Force) {
    if ($sub.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $sub.FullName -File -Force) { $result.Add("$($sub.Name)/$($file.Name)") }
  }
  return @($result | Where-Object { $_ -ne $StateFileName -and (Test-SafeRelativePath $_) })
}

function Get-PermissionSet($Manifest) {
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($key in 'permissions', 'optional_permissions', 'host_permissions', 'optional_host_permissions') {
    foreach ($value in @(Get-Prop $Manifest $key)) { if ($value) { $items.Add("${key}: $value") } }
  }
  foreach ($script in @(Get-Prop $Manifest 'content_scripts')) {
    foreach ($match in @(Get-Prop $script 'matches')) { if ($match) { $items.Add("content_scripts: $match") } }
  }
  $connectable = Get-Prop $Manifest 'externally_connectable'
  foreach ($match in @(Get-Prop $connectable 'matches')) { if ($match) { $items.Add("externally_connectable: $match") } }
  foreach ($id in @(Get-Prop $connectable 'ids')) { if ($id) { $items.Add("externally_connectable id: $id") } }
  foreach ($resource in @(Get-Prop $Manifest 'web_accessible_resources')) {
    foreach ($match in @(Get-Prop $resource 'matches')) { if ($match) { $items.Add("web_accessible_resources: $match") } }
  }
  return @($items | Sort-Object -Unique)
}

# ---------------------------------------------------------------- mạng

function Invoke-SafeGet([string]$Uri, [long]$MaxBytes, [string]$Accept = 'application/octet-stream') {
  # Tự đi theo chuyển hướng để kiểm tra từng tên miền: chỉ HTTPS tới GitHub.
  $current = New-Object System.Uri $Uri
  for ($hop = 0; $hop -le 5; $hop++) {
    if ($current.Scheme -ne 'https' -or $AllowedHosts -notcontains $current.Host.ToLowerInvariant()) {
      throw "Từ chối tải từ địa chỉ không được phép: $($current.Scheme)://$($current.Host)"
    }
    $request = [Net.HttpWebRequest]::Create($current)
    $request.Method = 'GET'
    $request.AllowAutoRedirect = $false
    $request.UserAgent = 'cvat-event-hotkeys-updater'
    $request.Accept = $Accept
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $request.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    try {
      $response = $request.GetResponse()
    } catch [Net.WebException] {
      $failed = $_.Exception.Response
      if ($null -eq $failed) { throw "Không kết nối được $($current.Host): $($_.Exception.Message)" }
      $code = [int]$failed.StatusCode
      $failed.Close()
      throw "GitHub trả về HTTP $code cho $($current.AbsolutePath)"
    }
    try {
      $code = [int]$response.StatusCode
      if ($code -ge 300 -and $code -lt 400) {
        $location = $response.Headers['Location']
        if (-not $location) { throw 'Chuyển hướng thiếu địa chỉ đích.' }
        $current = New-Object System.Uri -ArgumentList $current, $location
        continue
      }
      if ($code -ne 200) { throw "GitHub trả về HTTP $code" }
      if ($response.ContentLength -gt $MaxBytes) { throw "File tải về vượt giới hạn $MaxBytes byte." }
      $stream = $response.GetResponseStream()
      $memory = New-Object IO.MemoryStream
      $buffer = New-Object byte[] 65536
      while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $memory.Write($buffer, 0, $read)
        if ($memory.Length -gt $MaxBytes) { throw "File tải về vượt giới hạn $MaxBytes byte." }
      }
      return , $memory.ToArray()
    } finally {
      $response.Close()
    }
  }
  throw 'Quá nhiều lần chuyển hướng.'
}

function Get-LatestRelease {
  $bytes = Invoke-SafeGet "https://api.github.com/repos/$Repository/releases/latest" 2MB 'application/vnd.github+json'
  $release = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  if ((Get-Prop $release 'draft') -or (Get-Prop $release 'prerelease')) { return $null }
  $tag = [string](Get-Prop $release 'tag_name')
  if ($tag -notmatch '^v(\d{1,5}\.\d{1,5}\.\d{1,5})$') { return $null }
  $version = $Matches[1]
  $zipName = "cvat-event-hotkeys-v$version.zip"
  $base = "https://github.com/$Repository/releases/download/$tag"
  $assets = @(Get-Prop $release 'assets')
  $zip = $assets | Where-Object {
    (Get-Prop $_ 'name') -eq $zipName -and (Get-Prop $_ 'state') -eq 'uploaded' -and (Get-Prop $_ 'browser_download_url') -eq "$base/$zipName"
  } | Select-Object -First 1
  $sha = $assets | Where-Object {
    (Get-Prop $_ 'name') -eq "$zipName.sha256" -and (Get-Prop $_ 'state') -eq 'uploaded' -and (Get-Prop $_ 'browser_download_url') -eq "$base/$zipName.sha256"
  } | Select-Object -First 1
  $digest = $null
  if ($zip -and ([string](Get-Prop $zip 'digest')) -match '^sha256:([0-9a-fA-F]{64})$') { $digest = $Matches[1].ToLowerInvariant() }
  return [pscustomobject]@{
    Version = $version
    Tag = $tag
    ZipName = $zipName
    ZipUrl = if ($zip) { "$base/$zipName" } else { $null }
    ShaUrl = if ($sha) { "$base/$zipName.sha256" } else { $null }
    Digest = $digest
  }
}

# ---------------------------------------------------------------- kiểm tra và cài ZIP

function Test-ReleaseArchive([string]$ZipPath, [string]$ExpectedVersion) {
  $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    if ($archive.Entries.Count -gt $MaxEntries) { throw 'ZIP có quá nhiều file.' }
    $files = New-Object System.Collections.Generic.List[string]
    $total = 0L
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName
      if ($name.EndsWith('/') -and $entry.Length -eq 0) { continue }
      if (-not (Test-SafeRelativePath $name)) { throw "ZIP chứa đường dẫn hoặc loại file không được phép: '$name'" }
      if ($files -contains $name) { throw "ZIP chứa file trùng tên: '$name'" }
      $total += $entry.Length
      if ($total -gt $MaxUnpackedBytes) { throw 'ZIP giải nén vượt giới hạn dung lượng.' }
      $files.Add($name)
    }
    $manifestEntry = $archive.GetEntry('manifest.json')
    if (-not $manifestEntry) { throw 'ZIP không có manifest.json ở thư mục gốc.' }
    $reader = New-Object IO.StreamReader($manifestEntry.Open(), [Text.Encoding]::UTF8)
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ((Get-Prop $manifest 'name') -ne $ExtensionName) { throw 'manifest.json trong ZIP không phải của CVAT Event Hotkeys.' }
    if ((Get-Prop $manifest 'manifest_version') -ne 3) { throw 'manifest.json trong ZIP không dùng Manifest V3.' }
    if ((Get-Prop $manifest 'version') -ne $ExpectedVersion) {
      throw "Phiên bản trong ZIP ($((Get-Prop $manifest 'version'))) khác tag phát hành ($ExpectedVersion)."
    }
    return [pscustomobject]@{ Files = @($files); Manifest = $manifest }
  } finally {
    $archive.Dispose()
  }
}

function Expand-ReleaseArchive([string]$ZipPath, [string]$StageDir) {
  $root = [IO.Path]::GetFullPath($StageDir).TrimEnd('\') + '\'
  $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith('/')) { continue }
      $target = [IO.Path]::GetFullPath((Join-Path $StageDir ($entry.FullName -replace '/', '\')))
      if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Đường dẫn ra ngoài thư mục tạm: $($entry.FullName)" }
      New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  } finally {
    $archive.Dispose()
  }
}

function Copy-ReleaseFiles([string]$SourceDir, [string]$TargetDir, [string[]]$Files) {
  # manifest.json ghi sau cùng: extension chỉ kích hoạt khi mọi file khác đã sẵn sàng.
  $ordered = @($Files | Where-Object { $_ -ne 'manifest.json' }) + @($Files | Where-Object { $_ -eq 'manifest.json' })
  foreach ($name in $ordered) {
    $relative = $name -replace '/', '\'
    $source = Join-Path $SourceDir $relative
    $target = Join-Path $TargetDir $relative
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    $temporary = "$target.updating"
    Copy-Item -LiteralPath $source -Destination $temporary -Force
    Move-Item -LiteralPath $temporary -Destination $target -Force
  }
}

function Install-Release($Config, [string]$StageDir, $Checked) {
  $extensionDir = $Config.extensionDir
  $currentVersion = (Get-ManifestFromDir $extensionDir).version
  $backup = Join-Path $BackupRoot ('v{0}-{1}' -f $currentVersion, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $backupFiles = Get-ExtensionFiles $extensionDir
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  foreach ($name in $backupFiles) {
    $target = Join-Path $backup ($name -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $extensionDir ($name -replace '/', '\')) -Destination $target -Force
  }
  Write-Log "Đã sao lưu v$currentVersion vào $backup"

  try {
    $newFiles = @($Checked.Files)
    $stale = @($Config.installedFiles | Where-Object { $_ -and $newFiles -notcontains $_ -and (Test-SafeRelativePath $_) })
    Copy-ReleaseFiles $StageDir $extensionDir @($newFiles | Where-Object { $_ -ne 'manifest.json' })
    foreach ($name in $stale) {
      $path = Join-Path $extensionDir ($name -replace '/', '\')
      if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
    }
    Copy-ReleaseFiles $StageDir $extensionDir @('manifest.json')
  } catch {
    Write-Log "Cài đặt lỗi, đang khôi phục bản sao lưu: $($_.Exception.Message)" 'ERROR'
    Copy-ReleaseFiles $backup $extensionDir $backupFiles
    throw
  }

  $Config.installedFiles = $newFiles
  if ($newFiles -contains $UpdaterEntry) {
    $newScript = Join-Path $StageDir ($UpdaterEntry -replace '/', '\')
    if ($newScript -ne $InstalledScript) { Copy-Item -LiteralPath $newScript -Destination $InstalledScript -Force }
  }

  $old = @(Get-ChildItem -LiteralPath $BackupRoot -Directory | Sort-Object CreationTime -Descending | Select-Object -Skip $KeepBackups)
  foreach ($dir in $old) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force }
}

function Confirm-Update([string]$Version, [string]$CurrentVersion, [string[]]$AddedPermissions) {
  $text = "Có bản CVAT Event Hotkeys v$Version (máy đang dùng v$CurrentVersion).`n`n" +
    "File đã tải từ GitHub Releases của $Repository và đã khớp SHA-256."
  if ($AddedPermissions.Count) {
    $text += "`n`nCHÚ Ý: bản mới xin thêm quyền hoặc trang web:`n  - " + ($AddedPermissions -join "`n  - ") +
      "`n`nChỉ cài nếu bạn biết vì sao bản này cần các quyền trên."
  }
  $text += "`n`nCài bản mới ngay? Bạn sẽ được hỏi lại ở lần kiểm tra sau nếu chọn No."
  if ($Scheduled) {
    $icon = if ($AddedPermissions.Count) { 48 } else { 32 }
    # 4 = Yes/No, 4096 = luôn nổi trên cùng. Tự đóng sau 15 phút và hỏi lại ở lần sau.
    $answer = (New-Object -ComObject WScript.Shell).Popup($text, 900, $ExtensionName, 4 + $icon + 4096)
    return $answer -eq 6
  }
  Write-Host ''
  Write-Host $text -ForegroundColor Cyan
  $reply = Read-Host 'Gõ y để cài'
  return $reply -match '^\s*(y|yes|c|co)\s*$'
}

function Invoke-Check {
  $config = Read-Config
  if (-not $config) { throw 'Chưa cài trình cập nhật. Hãy chạy lệnh setup trước.' }
  $config.extensionDir = Resolve-ExtensionDir $config.extensionDir
  $current = Get-ManifestFromDir $config.extensionDir
  try { Register-NativeHost $config } catch { Write-Log "Không đăng ký được nút cập nhật: $($_.Exception.Message)" 'WARN' }
  $work = Join-Path $WorkRoot ([Guid]::NewGuid().ToString('N'))
  $result = 'error'
  $message = ''
  try {
    $release = Get-LatestRelease
    if (-not $release) {
      $result = 'no-release'; $message = 'Chưa có bản phát hành hợp lệ.'
      return
    }
    $config.latestVersion = $release.Version
    if ([version]$release.Version -le [version]$current.version) {
      $result = 'current'; $message = "Đang dùng bản mới nhất v$($current.version)."
      return
    }
    if ($config.skipVersion -eq $release.Version -and -not $Force) {
      $result = 'skipped'; $message = "Bỏ qua v$($release.Version) sau khi rollback. Chạy check -Force để cài."
      return
    }
    if (-not $release.ZipUrl) { $result = 'missing-asset'; $message = "v$($release.Version) chưa có ZIP."; return }
    if (-not $release.Digest -and -not $release.ShaUrl) {
      throw "v$($release.Version) không có SHA-256 để kiểm tra. Từ chối cài."
    }

    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $zipPath = Join-Path $work $release.ZipName
    [IO.File]::WriteAllBytes($zipPath, (Invoke-SafeGet $release.ZipUrl $MaxZipBytes))
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($release.Digest -and $hash -ne $release.Digest) { throw "SHA-256 không khớp với GitHub ($hash). Từ chối cài." }
    if ($release.ShaUrl) {
      $published = [Text.Encoding]::ASCII.GetString((Invoke-SafeGet $release.ShaUrl 4KB 'text/plain')).Trim().Split(' ')[0].ToLowerInvariant()
      if ($hash -ne $published) { throw "SHA-256 không khớp với file .sha256 ($hash). Từ chối cài." }
    }

    $checked = Test-ReleaseArchive $zipPath $release.Version
    $stage = Join-Path $work 'stage'
    Expand-ReleaseArchive $zipPath $stage

    $before = Get-PermissionSet $current
    $added = @(Get-PermissionSet $checked.Manifest | Where-Object { $before -notcontains $_ })
    if ($added.Count) { Write-Log "v$($release.Version) xin thêm quyền: $($added -join '; ')" 'WARN' }
    if (($config.mode -eq 'confirm' -and -not $Confirmed) -or $added.Count) {
      if (-not (Confirm-Update $release.Version $current.version $added)) {
        $result = 'declined'; $message = "Chưa cài v$($release.Version) theo lựa chọn của người dùng."
        return
      }
    }

    Install-Release $config $stage $checked
    $config.skipVersion = $null
    $result = 'installed'
    $message = "Đã cài v$($release.Version). Chrome tự kích hoạt trong khoảng 1 phút; tải lại tab CVAT để dùng bản mới."
  } catch {
    $result = 'error'
    $message = $_.Exception.Message
    $_.Exception.Data['logged'] = $true
    throw
  } finally {
    Write-Log $message $(if ($result -eq 'error') { 'ERROR' } else { 'INFO' })
    Write-UpdaterState $config $result $message
    Save-Config $config
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# ---------------------------------------------------------------- native messaging

# Đường dẫn với đúng chữ hoa/thường trên đĩa: ID của extension unpacked được tính từ nó.
function Get-TrueCasePath([string]$Path) {
  $dir = New-Object IO.DirectoryInfo ((Get-Item -LiteralPath $Path -Force).FullName.TrimEnd('\'))
  $parts = New-Object System.Collections.Generic.List[string]
  while ($dir.Parent) {
    $match = @($dir.Parent.GetDirectories($dir.Name)) | Where-Object { $_.Name -ieq $dir.Name } | Select-Object -First 1
    $parts.Insert(0, $(if ($match) { $match.Name } else { $dir.Name }))
    $dir = $dir.Parent
  }
  $root = $dir.FullName.Substring(0, 1).ToUpperInvariant() + $dir.FullName.Substring(1)
  return $root + ($parts -join '\')
}

# Chromium: SHA-256 của đường dẫn (UTF-16LE, ổ đĩa viết hoa), 16 byte đầu, mỗi nửa byte -> a..p.
function Get-UnpackedExtensionId([string]$Path) {
  if ($Path -match '^[a-z]:') { $Path = $Path.Substring(0, 1).ToUpperInvariant() + $Path.Substring(1) }
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($Path))
  return -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
}

function Register-NativeHost($Config) {
  $ids = @(Get-UnpackedExtensionId (Get-TrueCasePath $Config.extensionDir)) + @($Config.extensionIds) | Select-Object -Unique
  $origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  # %~dp0 giữ đúng đường dẫn kể cả khi tên người dùng có dấu. Chỉ truyền origin (%1) do Chrome cấp.
  $cmd = "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0cvat-hotkey-updater.ps1`" native -Origin %1`r`n"
  [IO.File]::WriteAllText($NativeHostCmd, $cmd, [Text.Encoding]::ASCII)
  $manifest = [ordered]@{
    name = $NativeHostName
    description = 'CVAT Event Hotkeys updater'
    path = $NativeHostCmd
    type = 'stdio'
    allowed_origins = $origins
  }
  Write-Utf8File $NativeHostManifest ($manifest | ConvertTo-Json)
  foreach ($root in $NativeRegistryRoots) {
    $key = "$root\$NativeHostName"
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $NativeHostManifest
  }
  $Config.allowedOrigins = $origins
}

function Unregister-NativeHost {
  foreach ($root in $NativeRegistryRoots) {
    $key = "$root\$NativeHostName"
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
  }
}

function Read-NativeMessage {
  $stdin = [Console]::OpenStandardInput()
  $read = {
    param([int]$Count)
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
      $got = $stdin.Read($buffer, $offset, $Count - $offset)
      if ($got -le 0) { throw 'Chrome đã đóng kết nối.' }
      $offset += $got
    }
    return , $buffer
  }
  $length = [BitConverter]::ToInt32((& $read 4), 0)
  if ($length -le 0 -or $length -gt 65536) { throw 'Thông điệp không hợp lệ.' }
  return [Text.Encoding]::UTF8.GetString((& $read $length)) | ConvertFrom-Json
}

function Write-NativeMessage($Object) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Object | ConvertTo-Json -Compress -Depth 4))
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

# Chrome chạy lệnh này khi extension gọi. Chỉ hai lệnh cố định; không tham số nào trong
# thông điệp được dùng làm đường dẫn hay dòng lệnh.
function Invoke-Native {
  try {
    $message = Read-NativeMessage
    $config = Read-Config
    if (-not $config) { Write-NativeMessage @{ ok = $false; error = 'not-configured' }; return }
    if (@($config.allowedOrigins) -notcontains $Origin) {
      Write-Log "Từ chối native messaging từ $Origin" 'WARN'
      Write-NativeMessage @{ ok = $false; error = 'origin' }
      return
    }
    switch ([string](Get-Prop $message 'type')) {
      'status' {
        Write-NativeMessage @{ ok = $true; mode = $config.mode; lastCheck = $config.lastCheck; lastResult = $config.lastResult }
      }
      'update' {
        $probe = New-Object Threading.Mutex($false, 'Local\CVATEventHotkeysUpdater')
        $free = $false
        try { $free = $probe.WaitOne(0) } catch [Threading.AbandonedMutexException] { $free = $true }
        if ($free) { $probe.ReleaseMutex() }
        $probe.Dispose()
        if ($free) {
          # Chạy tách khỏi Chrome để việc cài không bị ngắt khi popup đóng.
          $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" check -Scheduled -Confirmed -Force' -f $InstalledScript
          Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden
          Write-Log 'Bắt đầu cập nhật theo nút bấm trong extension.'
        }
        Write-NativeMessage @{ ok = $true; started = $free; running = -not $free }
      }
      default { Write-NativeMessage @{ ok = $false; error = 'unknown' } }
    }
  } catch {
    Write-Log "Native messaging lỗi: $($_.Exception.Message)" 'ERROR'
    try { Write-NativeMessage @{ ok = $false; error = $_.Exception.Message } } catch { }
  }
}

# ---------------------------------------------------------------- lịch chạy

function Register-UpdaterTask([int]$Hours) {
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $powershell = Join-Path $PSHOME 'powershell.exe'
  $argument = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" check -Scheduled' -f $InstalledScript
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $argument
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours $Hours)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  $description = "Kiểm tra GitHub Releases của $Repository và cập nhật CVAT Event Hotkeys. Gỡ bằng: $InstalledScript uninstall"
  try {
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $repeat) -Principal $principal `
      -Settings $settings -Description $description -Force | Out-Null
  } catch {
    Write-Log "Không tạo được trigger khi đăng nhập ($($_.Exception.Message)). Chỉ dùng lịch định kỳ." 'WARN'
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $repeat -Principal $principal `
      -Settings $settings -Description $description -Force | Out-Null
  }
}

# ---------------------------------------------------------------- các lệnh

function Read-Choice([string]$Prompt, [string]$Default) {
  $answer = Read-Host $Prompt
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer.Trim()
}

function Invoke-Setup {
  Write-Host ''
  Write-Host "=== Trình cập nhật tự động $ExtensionName ===" -ForegroundColor Cyan
  Write-Host @"
Trình cập nhật sẽ:
  - Chạy dưới tài khoản Windows hiện tại, không cần quyền Administrator.
  - Mỗi $IntervalHours giờ và khi đăng nhập, đọc bản phát hành mới nhất tại
    https://github.com/$Repository/releases (chỉ kết nối HTTPS tới GitHub).
  - Chỉ cài bản mới hơn bản đang dùng, có ZIP khớp SHA-256 và manifest đúng tên, đúng phiên bản.
  - Sao lưu bản đang dùng trước khi ghi đè (giữ $KeepBackups bản gần nhất, khôi phục bằng lệnh rollback).
  - Luôn hỏi lại nếu bản mới xin thêm quyền hoặc thêm trang web, kể cả ở chế độ tự động.
  - Cho nút "Cập nhật ngay" trong extension gọi trình cập nhật (native messaging, chỉ extension này).
Dữ liệu, nhật ký và bản sao lưu nằm trong $DataDir
"@

  $guess = $ExtensionDir
  if (-not $guess) {
    $existing = Read-Config
    if ($existing -and $existing.extensionDir) { $guess = $existing.extensionDir }
    elseif ($PSScriptRoot) { $guess = Split-Path $PSScriptRoot -Parent }
  }
  if (-not $Yes) {
    $guess = Read-Choice "Thư mục extension (chứa manifest.json) [$guess]" $guess
  }
  $resolved = Resolve-ExtensionDir $guess
  $manifest = Get-ManifestFromDir $resolved
  Write-Host "Thư mục extension: $resolved (v$($manifest.version))" -ForegroundColor Green

  $selected = $Mode
  if (-not $selected) {
    if ($Yes) { $selected = 'confirm' }
    else {
      Write-Host ''
      Write-Host 'Chọn chế độ cập nhật:'
      Write-Host '  1. Tự động: tải và cài ngay khi GitHub có bản mới.'
      Write-Host '  2. Hỏi trước: hiện hộp thoại, chỉ cài khi bạn bấm Yes. (mặc định)'
      $selected = if ((Read-Choice 'Lựa chọn [2]' '2') -eq '1') { 'auto' } else { 'confirm' }
    }
  }

  if (-not $Yes) {
    $reply = Read-Host "Bật trình cập nhật ở chế độ '$selected'? Gõ y để đồng ý"
    if ($reply -notmatch '^\s*(y|yes|c|co)\s*$') { Write-Host 'Đã hủy. Không có thay đổi nào.'; return }
  }

  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  $self = $PSCommandPath
  if ([IO.Path]::GetFullPath($self) -ne [IO.Path]::GetFullPath($InstalledScript)) {
    Copy-Item -LiteralPath $self -Destination $InstalledScript -Force
  }

  $config = Read-Config
  if (-not $config -or $config.extensionDir -ne $resolved) {
    $config = [ordered]@{ extensionDir = $resolved; mode = $selected; intervalHours = $IntervalHours; installedFiles = $null
      skipVersion = $null; lastCheck = $null; lastResult = $null; latestVersion = $null; extensionIds = @(); allowedOrigins = @() }
  }
  $config.mode = $selected
  $config.intervalHours = $IntervalHours
  Register-NativeHost $config
  Save-Config $config
  Register-UpdaterTask $IntervalHours
  Write-Log "Đã bật trình cập nhật: chế độ $selected, mỗi $IntervalHours giờ, thư mục $resolved"

  Write-Host ''
  Write-Host 'Kiểm tra bản mới lần đầu...' -ForegroundColor Cyan
  try { Invoke-Check } catch { Write-Host "Lần kiểm tra đầu lỗi: $($_.Exception.Message)" -ForegroundColor Yellow }
  Write-Host ''
  Write-Host "Xong. Xem trạng thái: $InstalledScript status" -ForegroundColor Green
  Write-Host 'Nút "Cập nhật ngay" trong cửa sổ extension giờ cài bản mới trực tiếp (Chrome và Edge).'
  Write-Host 'Lưu ý: Chrome phải đang dùng extension "Load unpacked" từ đúng thư mục trên.'
}

function Show-Status {
  $config = Read-Config
  if (-not $config) { Write-Host 'Trình cập nhật chưa được cài trên máy này.'; return }
  Write-Host "Thư mục extension : $($config.extensionDir)"
  try { Write-Host "Phiên bản trên đĩa: v$((Get-ManifestFromDir $config.extensionDir).version)" } catch { Write-Host "Phiên bản trên đĩa: lỗi - $($_.Exception.Message)" }
  Write-Host "Chế độ            : $($config.mode), mỗi $($config.intervalHours) giờ"
  Write-Host "Lần kiểm tra cuối : $($config.lastCheck) ($($config.lastResult))"
  Write-Host "Bản mới nhất      : $($config.latestVersion)"
  if ($config.skipVersion) { Write-Host "Đang bỏ qua       : v$($config.skipVersion)" }
  Write-Host "Nút cập nhật      : $(@($config.allowedOrigins) -join ', ')"
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "Lịch chạy         : $($task.State), lần tới $($info.NextRunTime), lần trước $($info.LastRunTime) (mã $($info.LastTaskResult))"
  } else {
    Write-Host 'Lịch chạy         : không tìm thấy' -ForegroundColor Yellow
  }
  if (Test-Path -LiteralPath $LogPath) {
    Write-Host ''
    Write-Host 'Nhật ký gần nhất:'
    Get-Content -LiteralPath $LogPath -Tail 10 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" }
  }
}

function Invoke-Rollback {
  $config = Read-Config
  if (-not $config) { throw 'Chưa cài trình cập nhật.' }
  $extensionDir = Resolve-ExtensionDir $config.extensionDir
  $current = (Get-ManifestFromDir $extensionDir).version
  $backup = Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object CreationTime -Descending | Select-Object -First 1
  if (-not $backup) { throw 'Chưa có bản sao lưu nào.' }
  $restored = (Get-ManifestFromDir $backup.FullName).version
  if (-not $Yes) {
    $reply = Read-Host "Khôi phục v$restored (đang dùng v$current)? Gõ y để đồng ý"
    if ($reply -notmatch '^\s*(y|yes|c|co)\s*$') { Write-Host 'Đã hủy.'; return }
  }
  $files = Get-ExtensionFiles $backup.FullName
  Copy-ReleaseFiles $backup.FullName $extensionDir $files
  $config.installedFiles = $files
  if ($current -ne $restored) { $config.skipVersion = $current }
  Write-UpdaterState $config 'rolled-back' "Đã khôi phục v$restored, bỏ qua v$current."
  Save-Config $config
  Remove-Item -LiteralPath $backup.FullName -Recurse -Force
  Write-Log "Đã khôi phục v$restored từ $($backup.Name). v$current sẽ không tự cài lại."
}

function Invoke-Uninstall {
  if (-not $Yes) {
    $reply = Read-Host 'Gỡ lịch chạy và dữ liệu của trình cập nhật (extension vẫn giữ nguyên)? Gõ y để đồng ý'
    if ($reply -notmatch '^\s*(y|yes|c|co)\s*$') { Write-Host 'Đã hủy.'; return }
  }
  $config = Read-Config
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Unregister-NativeHost
  if ($config -and $config.extensionDir) {
    $state = Join-Path $config.extensionDir $StateFileName
    if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Force }
  }
  if (Test-Path -LiteralPath $DataDir) { Remove-Item -LiteralPath $DataDir -Recurse -Force }
  Write-Host 'Đã gỡ trình cập nhật. Extension vẫn hoạt động; cập nhật thủ công qua nút Update trong Chrome.'
}

# ---------------------------------------------------------------- điểm vào

# Cho phép dot-source để kiểm thử từng hàm mà không chạy lệnh.
if ($MyInvocation.InvocationName -eq '.') { return }

if ($Command -eq 'native') {
  Invoke-Native
  exit 0
}

$mutex = New-Object Threading.Mutex($false, 'Local\CVATEventHotkeysUpdater')
$owned = $false
try {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) {
    Write-Log 'Một lần cập nhật khác đang chạy. Bỏ qua lần này.' 'WARN'
    exit 0
  }
  switch ($Command) {
    'setup' { Invoke-Setup }
    'check' { Invoke-Check }
    'status' { Show-Status }
    'rollback' { Invoke-Rollback }
    'uninstall' { Invoke-Uninstall }
  }
  exit 0
} catch {
  if (-not $_.Exception.Data['logged']) { Write-Log $_.Exception.Message 'ERROR' }
  exit 1
} finally {
  if ($owned) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}

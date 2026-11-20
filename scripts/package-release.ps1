# npm run release validates the committed release before invoking this packager.
param([switch]$SkipGuide)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $taskRoot 'dist'
$sourceManifest = Get-Content -LiteralPath (Join-Path $taskRoot 'manifest.json') -Raw | ConvertFrom-Json
$distManifest = Get-Content -LiteralPath (Join-Path $distRoot 'manifest.json') -Raw | ConvertFrom-Json
$metadata = Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath (Join-Path $taskRoot 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
$version = $sourceManifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$versions = @($distManifest.version, $metadata.version, $lock.version, $lock.packages[''].version)
if (@($versions | Where-Object { $_ -ne $version }).Count) { throw 'Source/build versions differ.' }
$status = @(git -C $taskRoot status --porcelain)
if ($LASTEXITCODE -ne 0 -or $status.Count) { throw 'Commit the release before packaging; the Git working tree must be clean.' }
$commit = git -C $taskRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify release commit.' }
$prepareArgs = @('--prepare-notes')
if ($SkipGuide) { $prepareArgs += '--skip-guide' }
$preparedJson = node (Join-Path $PSScriptRoot 'release.mjs') @prepareArgs
if ($LASTEXITCODE -ne 0) { throw 'Release notes or user guide validation failed.' }
$prepared = $preparedJson | ConvertFrom-Json
if ($prepared.version -ne $version) { throw 'Release notes version differs.' }
$checkPath = Join-Path $taskRoot "output/release-check-v$version.json"
$releaseInfo = [ordered]@{ schemaVersion = 1; name = 'UNK AI'; version = $version; tag = "v$version";
  commit = $commit; releaseDate = $prepared.date; generatedAt = [DateTime]::UtcNow.ToString('o');
  releaseNotes = 'RELEASE-NOTES.md' }
if (!$SkipGuide) { $releaseInfo.userGuide = 'USER-GUIDE.html' }
if (Test-Path -LiteralPath $checkPath -PathType Leaf) {
  $check = Get-Content -LiteralPath $checkPath -Raw | ConvertFrom-Json
  if ($check.version -ne $version -or $check.commit -ne $commit -or $check.passed -ne $true) { throw 'Release check record differs from this commit.' }
  $releaseInfo.validation = [ordered]@{ command = $check.command; passed = $true; completedAt = $check.completedAt }
}
$utf8 = [Text.UTF8Encoding]::new($false)
$releaseFiles = [ordered]@{
  'RELEASE-NOTES.md' = [IO.File]::ReadAllBytes($prepared.notesPath)
  'RELEASE-INFO.json' = $utf8.GetBytes(($releaseInfo | ConvertTo-Json -Depth 6) + [Environment]::NewLine)
}
if (!$SkipGuide) { $releaseFiles['USER-GUIDE.html'] = [IO.File]::ReadAllBytes((Join-Path $taskRoot 'docs/USER-GUIDE.html')) }
$packagePath = Join-Path $taskRoot "unk-ai-v$version.zip"
if (Test-Path -LiteralPath $packagePath) { throw "Package already exists: $packagePath" }
$prefix = [IO.Path]::GetFullPath($distRoot) + [IO.Path]::DirectorySeparatorChar
function Assert-DistFile([string]$relative) {
  $absolute = [IO.Path]::GetFullPath((Join-Path $distRoot $relative.TrimStart('/')))
  if (!$absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $absolute -PathType Leaf)) {
    throw "Missing or invalid build entry: $relative"
  }
}
$required = @($distManifest.background.service_worker, $distManifest.side_panel.default_path, $distManifest.options_ui.page,
  'src/sidepanel/theme-boot.js', 'content/agent-scanner.js', 'pdfjs/LICENSE', 'third-party/mp4box.LICENSE', 'third-party/fflate.LICENSE',
  "_locales/$($distManifest.default_locale)/messages.json")
$required += $distManifest.content_scripts | ForEach-Object { $_.js }
$required += $distManifest.icons.PSObject.Properties.Value
$required += $distManifest.action.default_icon.PSObject.Properties.Value
foreach ($relative in $required) { Assert-DistFile $relative }
foreach ($html in Get-ChildItem -LiteralPath $distRoot -Filter '*.html' -Recurse -File) {
  foreach ($match in [regex]::Matches((Get-Content -LiteralPath $html.FullName -Raw), '(?:src|href)=["'']([^"'']+)["'']')) {
    $url = $match.Groups[1].Value
    if ($url -match '^(?:#|data:|https?:)') { continue }
    $file = if ($url.StartsWith('/')) { Join-Path $distRoot $url.TrimStart('/') } else { Join-Path $html.DirectoryName $url }
    Assert-DistFile ([IO.Path]::GetRelativePath($distRoot, $file))
  }
}
$sourceHash = (Get-FileHash -LiteralPath (Join-Path $taskRoot 'manifest.json') -Algorithm SHA256).Hash
if ($sourceHash -ne (Get-FileHash -LiteralPath (Join-Path $distRoot 'manifest.json') -Algorithm SHA256).Hash) { throw 'Built manifest differs from source.' }
$files = @(Get-ChildItem -LiteralPath $distRoot -Recurse -File | Sort-Object FullName)
$expected = @{}
foreach ($file in $files) {
  $relative = [IO.Path]::GetRelativePath($distRoot, $file.FullName).Replace('\', '/')
  if (($relative.Split('/')[0] -notin @('_locales', 'assets', 'content', 'icons', 'pdfjs', 'src', 'manifest.json', 'service-worker.js') -and
    $relative -notin @('third-party/mp4box.LICENSE', 'third-party/fflate.LICENSE')) -or
    $file.Extension -in @('.zip', '.map', '.pem', '.key', '.pfx', '.env') -or
    ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Unexpected build file: $relative" }
  $expected[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($distRoot, $packagePath, [IO.Compression.CompressionLevel]::Optimal, $false)
$archive = [IO.Compression.ZipFile]::Open($packagePath, [IO.Compression.ZipArchiveMode]::Update)
try {
  foreach ($name in $releaseFiles.Keys) {
    if ($archive.GetEntry($name)) { throw "Build already includes release metadata: $name" }
    $bytes = $releaseFiles[$name]
    $entry = $archive.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    $expected[$name] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
  }
} finally { $archive.Dispose() }
$archive = [IO.Compression.ZipFile]::OpenRead($packagePath)
$verified = @()
try {
  $entries = @($archive.Entries | Where-Object { $_.Name })
  if ($entries.Count -ne $expected.Count -or !$archive.GetEntry('manifest.json')) { throw 'ZIP root or file count is incorrect.' }
  foreach ($entry in $entries) {
    if (!$expected.ContainsKey($entry.FullName)) { throw "Unexpected ZIP entry: $($entry.FullName)" }
    $stream = $entry.Open()
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $hash = [Convert]::ToHexString($algorithm.ComputeHash($stream)) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
    if ($hash -ne $expected[$entry.FullName]) { throw "ZIP bytes differ: $($entry.FullName)" }
    $verified += [ordered]@{ path = $entry.FullName; bytes = $entry.Length; sha256 = $hash.ToLowerInvariant() }
  }
} finally { $archive.Dispose() }
$report = [ordered]@{ version = $version; commit = $commit; package = $packagePath;
  checkedAt = [DateTime]::UtcNow.ToString('o'); bytes = (Get-Item -LiteralPath $packagePath).Length;
  sha256 = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant();
  manifestAtRoot = $true; allBuildFilesEqualDist = $true; releaseFiles = @($releaseFiles.Keys); fileCount = $verified.Count; files = $verified }
$reportDir = Join-Path $taskRoot 'output'
[IO.Directory]::CreateDirectory($reportDir) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $reportDir "package-v$version-validation.json") -Encoding utf8
[pscustomobject]$report | Select-Object version, commit, package, bytes, sha256, fileCount, manifestAtRoot, allBuildFilesEqualDist, releaseFiles | ConvertTo-Json

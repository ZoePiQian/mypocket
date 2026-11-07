param([Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$VaultPath, [switch]$Enable)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$vaultRoot = (Resolve-Path -LiteralPath $VaultPath).Path
$configRoot = Join-Path $vaultRoot '.obsidian'
if (-not (Test-Path -LiteralPath $configRoot -PathType Container)) { throw '目标目录不是 Obsidian 仓库：缺少 .obsidian。' }
$pluginRoot = Join-Path $configRoot 'plugins\local-finance-notes'
# Check the whole package before creating or replacing any installed file.
foreach ($name in @('main.js', 'manifest.json', 'styles.css')) {
  $source = Join-Path $sourceRoot "安装文件\local-finance-notes\$name"
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少安装文件：$name；请先运行 node scripts/build.js。" }
}
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot '安装文件\local-finance-notes\manifest.json') -Raw | ConvertFrom-Json
if ($manifest.id -ne 'local-finance-notes') { throw '安装包的插件 ID 不匹配，未替换文件。' }
New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
foreach ($name in @('main.js', 'manifest.json', 'styles.css')) {
  $source = Join-Path $sourceRoot "安装文件\local-finance-notes\$name"
  Copy-Item -LiteralPath $source -Destination (Join-Path $pluginRoot $name) -Force
}
if ($Enable) {
  $listPath = Join-Path $configRoot 'community-plugins.json'
  $plugins = @()
  if (Test-Path -LiteralPath $listPath) {
    $plugins = @(Get-Content -LiteralPath $listPath -Raw | ConvertFrom-Json)
    if ($plugins -notcontains 'local-finance-notes') {
      $backupRoot = Join-Path $sourceRoot '.local\backups'
      New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
      $backup = Join-Path $backupRoot "community-plugins.before-install-$(Get-Date -Format yyyyMMdd-HHmmss).json.bak"
      Copy-Item -LiteralPath $listPath -Destination $backup
    }
  }
  if ($plugins -notcontains 'local-finance-notes') {
    $plugins += 'local-finance-notes'
    $json = ConvertTo-Json -InputObject @($plugins)
    [IO.File]::WriteAllText($listPath, $json, [Text.UTF8Encoding]::new($false))
  }
}
Write-Output "插件已复制至 $pluginRoot"

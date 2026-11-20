# CherunoASMR 的安裝、啟動、停止、更新（startserver.bat／stopserver.bat／update.bat 呼叫這支）
# 全部東西都放在 repo 資料夾裡：runtime\（uv、Node、Python、各引擎的環境與執行檔、ffmpeg）、models\（TTS 模型）、data\（存檔區）
# 只有 LM Studio 裝在系統上（要用本機 LLM 才需要；改用雲端 API 就不用）
#
#   cheruno.ps1 start [setup] [lan]   第一次會檢查並安裝；setup＝重新選要裝哪些語音引擎；lan＝讓同一個網路的平板連
#   cheruno.ps1 stop                  停掉這個資料夾開的所有程式
#   cheruno.ps1 update                停掉 → 更新程式 → 更新依賴
#   cheruno.ps1 rag <指令> [參數]      建自己的參考範例索引（rag\README.md）：在 data\rag 執行 cheruno-rag，輸出到 data\rag\out\<名稱>\
param([Parameter(Position = 0)][ValidateSet('start', 'stop', 'update', 'rag')][string]$Mode = 'start', [Parameter(ValueFromRemainingArguments = $true)][string[]]$Flags = @())

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Repo = Split-Path -Parent $PSScriptRoot
# 路徑有空格或中文時，部分程式（Start-Process 的參數、ZONOS、Python 套件）會出錯：直接說清楚，不硬跑
if ($Repo -notmatch '^[A-Za-z]:\\[A-Za-z0-9_.\\-]*$') {
    Write-Host "這個資料夾的路徑有空格、中文或特殊字元：$Repo" -ForegroundColor Red
    Write-Host '請把整個資料夾搬到只有英文字母、數字、- 和 _ 的路徑（例如 D:\CherunoASMR）再執行' -ForegroundColor Red
    exit 1
}
$Runtime = Join-Path $Repo 'runtime'
$Models = Join-Path $Repo 'models'
$Data = Join-Path $Repo 'data'
$Downloads = Join-Path $Runtime 'downloads'
$InstallFile = Join-Path $Runtime 'install.json'
$PublicRepo = 'cap-tcher/CherunoASMR'

# 固定版本（換版本時一起改）
$UvVersion = '0.6.8'
$NodeVersion = '24.15.0'
$FfmpegVersion = '9.0.2'
$ZonosRelease = 'zonos3-server-r1'
$ZonosZip = 'zonos3-server-win64-cuda12.8.zip'
$ZonosHf = @{ Repo = 'Zyphra/ZONOS3-Mini'; Rev = '2921b8821772b0bd10a04456863d21abf9d2f283'; Dir = 'zonos'; Files = [ordered]@{
        'gguf/backbone-ptq.gguf' = 663150624; 'gguf/zac-keep2.gguf' = 452325440; 'gguf/spk-encoder.gguf' = 45385728; 'gguf/steer.gguf' = 204960 } }
$QwenHf = @{ Repo = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'; Rev = '5ecdb67327fd37bb2e042aab12ff7391903235d3'; Dir = 'qwen\Qwen3-TTS-12Hz-1.7B-VoiceDesign'; Files = [ordered]@{
        'config.json' = 4421; 'generation_config.json' = 245; 'merges.txt' = 1671839; 'model.safetensors' = 3833402552; 'preprocessor_config.json' = 127
        'tokenizer_config.json' = 7344; 'vocab.json' = 2776833; 'speech_tokenizer/config.json' = 2336; 'speech_tokenizer/configuration.json' = 76
        'speech_tokenizer/model.safetensors' = 682293092; 'speech_tokenizer/preprocessor_config.json' = 234 } }

# Windows 內建的 curl／tar（PATH 裡可能先找到 Git 附的 GNU tar，它不認得有磁碟代號的路徑）
$Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $Curl) -or -not (Test-Path $Tar)) { Write-Host '這台 Windows 沒有內建的 curl.exe／tar.exe（Windows 10 1803 以後才有）：請先更新 Windows' -ForegroundColor Red; exit 1 }

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step([string]$msg) { Write-Host ''; Write-Host "== $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host ''; Write-Host "失敗：$msg" -ForegroundColor Red; exit 1 }

# ---- 下載 ----
function Get-Download([string]$url, [string]$dest, [long]$size = 0) {
    if ((Test-Path $dest) -and ($size -eq 0 -or (Get-Item $dest).Length -eq $size)) { return }
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    $part = "$dest.part"
    Say "  下載 $(Split-Path $dest -Leaf)$(if ($size) { '（{0:N0} MB）' -f ($size / 1MB) })"
    # curl.exe 是 Windows 10 內建的；-C - 斷線後再跑會接著下載
    & $Curl -L --fail --retry 3 --retry-delay 5 -C - -o $part $url
    if ($LASTEXITCODE -ne 0) { Fail "下載失敗（$url）：檢查網路後重新執行" }
    if ($size -and (Get-Item $part).Length -ne $size) { Remove-Item $part -Force; Fail "下載的檔案大小不對（$url）：重新執行會重新下載" }
    Move-Item -Force $part $dest
}

function Expand-Zip([string]$zip, [string]$dest) {
    New-Item -ItemType Directory -Force $dest | Out-Null
    & $Tar -xf $zip -C $dest
    if ($LASTEXITCODE -ne 0) { Fail "解壓縮失敗：$zip" }
}

# 模型：逐檔檢查大小，已經放好（自己下載、搬進來）的就不重下
function Install-HfModel($m) {
    $root = Join-Path $Models $m.Dir
    foreach ($f in $m.Files.Keys) {
        $name = if ($m.Dir -eq 'zonos') { Split-Path $f -Leaf } else { $f }
        $dest = Join-Path $root ($name -replace '/', '\')
        Get-Download "https://huggingface.co/$($m.Repo)/resolve/$($m.Rev)/$f" $dest $m.Files[$f]
    }
}

function Test-HfModel($m) {
    $root = Join-Path $Models $m.Dir
    foreach ($f in $m.Files.Keys) {
        $name = if ($m.Dir -eq 'zonos') { Split-Path $f -Leaf } else { $f }
        $p = Join-Path $root ($name -replace '/', '\')
        if (-not (Test-Path $p) -or (Get-Item $p).Length -ne $m.Files[$f]) { return $false }
    }
    return $true
}

# ---- 工具：uv、Node ----
$Uv = Join-Path $Runtime 'uv\uv.exe'
$NodeDir = Join-Path $Runtime 'node'
$Npm = Join-Path $NodeDir 'npm.cmd'

function Use-RepoEnv {
    # uv 的快取與它裝的 Python、npm 的快取都放 runtime\；不用系統上的 Python
    $env:UV_CACHE_DIR = Join-Path $Runtime 'uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $Runtime 'python'
    $env:UV_PYTHON_PREFERENCE = 'only-managed'
    $env:UV_LINK_MODE = 'copy'
    $env:npm_config_cache = Join-Path $Runtime 'npm-cache'
    $env:npm_config_update_notifier = 'false'
    $env:PATH = "$NodeDir;$(Split-Path $Uv);$env:PATH"
}

function Install-Tools {
    if (-not (Test-Path $Uv)) {
        Step "安裝 uv $UvVersion（Python 套件管理）"
        $zip = Join-Path $Downloads "uv-$UvVersion.zip"
        Get-Download "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip" $zip
        Expand-Zip $zip (Split-Path $Uv)
    }
    if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) {
        Step "安裝 Node.js $NodeVersion"
        $zip = Join-Path $Downloads "node-$NodeVersion.zip"
        Get-Download "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" $zip
        $tmp = Join-Path $Runtime 'node-tmp'
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        Expand-Zip $zip $tmp
        if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
        Move-Item (Join-Path $tmp "node-v$NodeVersion-win-x64") $NodeDir
        Remove-Item -Recurse -Force $tmp
    }
}

function Install-AppDeps {
    Step '檢查 app 與音訊服務的依賴'
    Push-Location $Repo
    try {
        & $Uv sync --project audio --frozen --no-dev
        if ($LASTEXITCODE -ne 0) { Fail '音訊服務的 Python 環境安裝失敗（看上面的訊息）' }
        # package-lock.json 變了（更新後）或還沒裝才跑 npm ci
        $lock = (Get-FileHash (Join-Path $Repo 'package-lock.json')).Hash
        $stamp = Join-Path $Runtime 'npm-lock.sha256'
        if (-not (Test-Path (Join-Path $Repo 'node_modules')) -or -not (Test-Path $stamp) -or (Get-Content $stamp) -ne $lock) {
            & $Npm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { Fail 'app 的依賴安裝失敗（看上面的訊息）' }
            Set-Content -Encoding ascii $stamp $lock
        }
    }
    finally { Pop-Location }
}

# ---- 語音引擎 ----
function Get-Install {
    if (Test-Path $InstallFile) { return Get-Content -Raw $InstallFile | ConvertFrom-Json }
    return $null
}

function Ask([string]$q) {
    while ($true) {
        $a = (Read-Host "$q [Y/n]").Trim().ToLower()
        if ($a -eq '' -or $a -eq 'y') { return $true }
        if ($a -eq 'n') { return $false }
    }
}

function Select-Engines {
    Step '選要裝的語音引擎（之後執行 startserver.bat setup 可以補裝）'
    Say '  ZONOS3-Mini：每句即時合成，平常念台詞用。要 NVIDIA 顯卡。下載約 1.5 GB（伺服器＋模型＋ffmpeg）'
    Say '  Qwen3-TTS VoiceDesign：用文字描述設計角色的聲音（ZONOS 的聲音也從這裡來）。要 NVIDIA 顯卡。下載約 7 GB（Python 環境＋模型）'
    Say "  模型已經自己下載好的話，照 models\README.md 放好，這裡就不會重下"
    if ($env:CHERUNO_ENGINES) {
        # 無人值守：CHERUNO_ENGINES=zonos,qwen（逗號分隔；none＝都不裝）
        $want = $env:CHERUNO_ENGINES.ToLower().Split(',') | ForEach-Object { $_.Trim() }
        $sel = [ordered]@{ zonos = ($want -contains 'zonos'); qwen = ($want -contains 'qwen') }
        Say "  CHERUNO_ENGINES：ZONOS $($sel.zonos)、Qwen $($sel.qwen)"
    }
    else { $sel = [ordered]@{ zonos = (Ask '  裝 ZONOS？'); qwen = (Ask '  裝 Qwen 聲音設計？') } }
    New-Item -ItemType Directory -Force $Runtime | Out-Null
    ($sel | ConvertTo-Json) | Set-Content -Encoding utf8 $InstallFile
    return Get-Install
}

function Install-Zonos {
    $exe = Join-Path $Runtime 'zonos\zonos3-server.exe'
    if (-not (Test-Path $exe)) {
        Step 'ZONOS 伺服器'
        $zip = Join-Path $Downloads $ZonosZip  # 這個檔案已經在 runtime\downloads 裡就直接用（離線安裝）
        Get-Download "https://github.com/$PublicRepo/releases/download/$ZonosRelease/$ZonosZip" $zip
        Expand-Zip $zip (Join-Path $Runtime 'zonos')
    }
    if (-not (Test-HfModel $ZonosHf)) { Step 'ZONOS 模型'; Install-HfModel $ZonosHf }
    $ff = Join-Path $Runtime 'ffmpeg\bin\ffmpeg.exe'
    if (-not (Test-Path $ff)) {
        Step "ffmpeg $FfmpegVersion（ZONOS 登錄聲音時解碼用）"
        $zip = Join-Path $Downloads "ffmpeg-$FfmpegVersion.zip"
        Get-Download "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVersion/ffmpeg-$FfmpegVersion-essentials_build.zip" $zip
        $tmp = Join-Path $Runtime 'ffmpeg-tmp'
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        Expand-Zip $zip $tmp
        $dir = Get-ChildItem $tmp -Directory | Select-Object -First 1
        $target = Join-Path $Runtime 'ffmpeg'
        if (Test-Path $target) { Remove-Item -Recurse -Force $target }
        Move-Item $dir.FullName $target
        Remove-Item -Recurse -Force $tmp
    }
}

function Install-Qwen {
    $py = Join-Path $Runtime 'qwen\.venv\Scripts\python.exe'
    $stamp = Join-Path $Runtime 'qwen\uv.lock.sha256'
    $lock = (Get-FileHash (Join-Path $Repo 'tts\qwen\uv.lock')).Hash
    if (-not (Test-Path $py) -or -not (Test-Path $stamp) -or (Get-Content $stamp) -ne $lock) {
        Step 'Qwen 的 Python 環境（PyTorch CUDA 版，約 3 GB，要一點時間）'
        $env:UV_PROJECT_ENVIRONMENT = Join-Path $Runtime 'qwen\.venv'
        & $Uv sync --project (Join-Path $Repo 'tts\qwen') --frozen
        $code = $LASTEXITCODE
        Remove-Item Env:UV_PROJECT_ENVIRONMENT
        if ($code -ne 0) { Fail 'Qwen 的 Python 環境安裝失敗（看上面的訊息）' }
        Set-Content -Encoding ascii $stamp $lock
    }
    if (-not (Test-HfModel $QwenHf)) { Step 'Qwen 模型'; Install-HfModel $QwenHf }
}

function Install-All([bool]$reselect) {
    New-Item -ItemType Directory -Force $Runtime, $Models, $Data, $Downloads | Out-Null
    Install-Tools
    Use-RepoEnv
    Install-AppDeps
    $inst = Get-Install
    if ($reselect -or -not $inst) { $inst = Select-Engines }
    if ($inst.zonos) { Install-Zonos }
    if ($inst.qwen) { Install-Qwen }
    # 存檔區：第一次預設放 data\（之後可在 app 的存檔畫面換）
    $cfg = Join-Path $Data 'config.json'
    # 不帶 BOM（Windows PowerShell 的 utf8 會加 BOM，Python 的 json 讀不了）
    if (-not (Test-Path $cfg)) { [IO.File]::WriteAllText($cfg, (@{ dataDir = $Data } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false)) }
}

# ---- 啟動、停止 ----
function Test-Up([string]$url) {
    try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url; return $true } catch { return $false }
}

function Find-Lms {
    $c = Get-Command lms -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:USERPROFILE '.cache\lm-studio\bin\lms.exe'
    if (Test-Path $p) { return $p }
    return $null
}

function Start-All([bool]$lan) {
    # 埠號平常固定 8790／5173；測試時用環境變數換一組，免得跟已經開著的另一份撞到
    $ap = if ($env:CHERUNO_AUDIO_PORT) { $env:CHERUNO_AUDIO_PORT } else { '8790' }
    $wp = if ($env:CHERUNO_APP_PORT) { $env:CHERUNO_APP_PORT } else { '5173' }
    $audio = "http://127.0.0.1:$ap"; $app = "http://127.0.0.1:$wp"
    if ($ap -ne '8790') { $env:VITE_STORE_BASE = $audio; $env:CHERUNO_AUDIO_TARGET = $audio }
    if ($wp -ne '5173') { $env:CHERUNO_APP_ORIGINS = "$app,http://localhost:$wp" }
    $logs = Join-Path $Data 'logs'
    New-Item -ItemType Directory -Force $logs | Out-Null
    if (Test-Up "$audio/health") { Say '音訊服務已經在跑' } else {
        Step '啟動音訊服務'
        Start-Process -FilePath $Uv -ArgumentList 'run', '--project', (Join-Path $Repo 'audio'), '--frozen', '--no-dev', 'cheruno-audio' -WorkingDirectory $Repo `
            -RedirectStandardOutput (Join-Path $logs 'audio.out.log') -RedirectStandardError (Join-Path $logs 'audio.log') -WindowStyle Hidden | Out-Null
    }
    if (Test-Up "$app/") { Say 'app 已經在跑（要切換區網模式，先執行 stopserver.bat）' } else {
        Step '啟動 app'
        $env:CHERUNO_HOST = if ($lan) { '0.0.0.0' } else { '127.0.0.1' }
        Start-Process -FilePath $Npm -ArgumentList 'run', 'dev', '-w', 'app', '--', '--port', $wp -WorkingDirectory $Repo `
            -RedirectStandardOutput (Join-Path $logs 'app.log') -RedirectStandardError (Join-Path $logs 'app.err.log') -WindowStyle Hidden | Out-Null
    }
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ((Test-Up "$audio/health") -and (Test-Up "$app/")) { $ok = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ok) { Fail "啟動逾時：看 $logs 裡的 audio.log、app.log" }
    Say ''
    Say "CherunoASMR 開好了：$app" 'Green'
    if ($lan) {
        Say '同一個網路的平板開下面其中一個（第一次 Windows 防火牆會問要不要讓 Node.js 用私人網路，按允許）：'
        Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' -and $_.InterfaceAlias -notlike 'vEthernet*' } |
            ForEach-Object { Say "  http://$($_.IPAddress):$wp  ($($_.InterfaceAlias))" }
    }
    if (-not (Find-Lms)) { Say '沒找到 LM Studio：要用本機 LLM 請安裝 LM Studio（lmstudio.ai）並開過一次；用 Claude／Gemini／OpenAI 的 API 就不需要' 'Yellow' }
    if ($env:CHERUNO_NO_WAIT) { return }  # 無人值守（測試）：開好就結束，程式留著跑、不開瀏覽器
    Start-Process $app
    Say ''
    Say '關掉：執行 stopserver.bat（或在這個視窗按 Enter）' 'Gray'
    $null = Read-Host
    Stop-All
}

function Stop-All {
    # 只停「執行檔放在這個資料夾裡」的程式：runtime\node（app）、audio\.venv 與 runtime\python（音訊服務）、
    # runtime\zonos、runtime\qwen、runtime\uv。只看命令列會誤停開著這個資料夾的編輯器或終端機
    $n = 0
    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Repo + '\', 'OrdinalIgnoreCase') } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    Say "已停止 $n 個程式"
}

function Update-Repo {
    Stop-All
    Step '更新程式'
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git -and (Test-Path (Join-Path $Repo '.git'))) {
        & git -C $Repo pull --ff-only
        if ($LASTEXITCODE -ne 0) { Fail 'git pull 失敗：有自己改過的檔案的話先還原或另存' }
    }
    else {
        # 沒有 git（下載 zip 的）：下載最新版覆蓋程式，不動 runtime\、models\、data\、cheruno.local.json
        $zip = Join-Path $Downloads 'latest.zip'
        if (Test-Path $zip) { Remove-Item -Force $zip }
        Get-Download "https://github.com/$PublicRepo/archive/refs/heads/main.zip" $zip
        $tmp = Join-Path $Runtime 'update-tmp'
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        Expand-Zip $zip $tmp
        $src = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
        & robocopy.exe $src $Repo /E /XD (Join-Path $src 'runtime') (Join-Path $src 'models') (Join-Path $src 'data') /XF cheruno.local.json /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail '覆蓋檔案失敗' }
        Remove-Item -Recurse -Force $tmp
    }
    Install-All $false
    Say ''
    Say '更新好了：執行 startserver.bat 開啟' 'Green'
}

function Invoke-Rag([string[]]$RagArgs) {
    # 用音訊服務的環境（cheruno-rag 是它的依賴）；還沒裝好就先跑 startserver.bat
    if (-not (Test-Path $Uv) -or -not (Test-Path (Join-Path $Repo 'audio\.venv'))) { Fail '還沒安裝：先執行一次 startserver.bat' }
    Use-RepoEnv
    $work = Join-Path $Data 'rag'
    New-Item -ItemType Directory -Force (Join-Path $work 'configs') | Out-Null
    Push-Location $work
    try {
        & $Uv run --project (Join-Path $Repo 'audio') --frozen --no-dev cheruno-rag @RagArgs
        $code = $LASTEXITCODE
    }
    finally { Pop-Location }
    exit $code
}

switch ($Mode) {
    'start' { Install-All ($Flags -contains 'setup'); Start-All ($Flags -contains 'lan') }
    'stop' { Stop-All }
    'update' { Update-Repo }
    'rag' { Invoke-Rag $Flags }
}

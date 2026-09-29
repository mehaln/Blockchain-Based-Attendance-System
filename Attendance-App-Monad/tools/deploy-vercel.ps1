# Puts the Attendance App online with Vercel (free) and opens the new link.
# Started by double-clicking "2 - Put App Online (Vercel).bat". Nothing needs to be installed:
# if the laptop has no Node.js, a private copy is downloaded once into
# %LOCALAPPDATA%\AttendanceApp (Windows itself is not changed).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$here = Split-Path -Parent $PSScriptRoot
$app = (Resolve-Path (Join-Path $here 'attendance-app')).Path
$linkFile = Join-Path $here 'My app link.txt'

function Say([string]$text, [string]$color = 'White') { Write-Host $text -ForegroundColor $color }
function Fail([string]$text) {
    Say ''
    Say $text 'Red'
    Say 'If it keeps failing, take a photo of this window and send it to the person who gave you this app.' Red
    exit 1
}

# The Vercel upload tool runs on Node.js: use the laptop's own copy, or download a private one
function Get-NodeDir {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $dir = Split-Path $cmd.Source
        $version = & $cmd.Source -v
        if ($version -match '^v(\d+)' -and [int]$Matches[1] -ge 20 -and
            (Test-Path (Join-Path $dir 'node_modules\npm\bin\npx-cli.js'))) { return $dir }
    }
    $base = Join-Path $env:LOCALAPPDATA 'AttendanceApp'
    $existing = Get-ChildItem $base -Directory -Filter 'node-v*' -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
    if ($existing) { return $existing.FullName }

    Say '  First time only: downloading a small helper (about 30 MB, 1-2 minutes)...' 'Yellow'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    # Assign first: Windows PowerShell 5.1 pipes Invoke-RestMethod's array as one object
    $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $version = ($releases | Where-Object { $_.lts } | Select-Object -First 1).version
    $name = "node-$version-win-$arch"
    New-Item -ItemType Directory -Force $base | Out-Null
    $zip = Join-Path $base "$name.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$version/$name.zip" -OutFile $zip -UseBasicParsing
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) { & $tar -xf $zip -C $base } else { Expand-Archive $zip $base -Force }
    Remove-Item $zip
    return (Join-Path $base $name)
}

# Runs the Vercel tool, shows its messages, and opens its login page when it prints one
function Invoke-Vercel([string]$arguments, [switch]$Quiet) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = "/d /s /c `"`"$node`" `"$npxCli`" --yes vercel@latest $arguments --no-color 2>&1`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.WorkingDirectory = $here
    $process = [System.Diagnostics.Process]::Start($psi)
    $lines = New-Object System.Collections.Generic.List[string]
    $esc = [char]27
    $inJson = $false
    while ($null -ne ($raw = $process.StandardOutput.ReadLine())) {
        $line = $raw -replace "$esc\[[0-9;?]*[A-Za-z]", ''
        $lines.Add($line)
        if ($line -match '(https://vercel\.com/oauth/device\S+)') {
            Say "  Opening $($Matches[1])" 'Cyan'
            Start-Process $Matches[1]
            continue
        }
        # The tool ends with a JSON summary and prints build details; hide that noise
        if ($line.Trim() -eq '{') { $inJson = $true }
        if ($Quiet -or $inJson -or -not $line.Trim()) { continue }
        if ($line -match 'telemetry|roadmap|opt-out|Vercel CLI \d|Uploading \[|Building|Completing|Command|Directory|framework|Loading teams|Searching for') { continue }
        Say "  $line" 'DarkGray'
    }
    $process.WaitForExit()
    return [pscustomobject]@{ Code = $process.ExitCode; Output = $lines }
}

Say ''
Say '  === Put the Attendance App online (free, with Vercel) ===' Cyan
Say ''
Say '  Step 1 of 3: getting ready...'
try {
    $nodeDir = Get-NodeDir
} catch {
    Fail "  Could not download the helper. Check the internet connection and double-click the file again.`n  ($($_.Exception.Message))"
}
$node = Join-Path $nodeDir 'node.exe'
$npxCli = Join-Path $nodeDir 'node_modules\npm\bin\npx-cli.js'
$env:PATH = "$nodeDir;$env:PATH"

Say ''
Say '  Step 2 of 3: your Vercel account'
$who = Invoke-Vercel 'whoami' -Quiet
if ($who.Code -eq 0) {
    Say '  Already logged in.' 'Green'
} else {
    Say '  A Vercel page opens in your browser:' 'Yellow'
    Say '    - log in, or make a free account (if asked for a plan, pick Hobby - it is free)' 'Yellow'
    Say '    - then click "Allow" / "Confirm", and come back to this window' 'Yellow'
    Say ''
    $login = Invoke-Vercel 'login'
    if ($login.Code -ne 0) { Fail '  The login did not finish. Double-click the file again to retry.' }
}

Say ''
Say '  Step 3 of 3: putting the app online (about a minute)...'
$deploy = Invoke-Vercel "deploy `"$app`" --prod --yes"
if ($deploy.Code -ne 0) { Fail '  Vercel could not publish the app. Read the messages above, then double-click the file again.' }

# Vercel prints several links; the production one is the public address
$production = $deploy.Output | Select-String -Pattern '"productionUrl":\s*"(https://[^"]+)"' | Select-Object -First 1
$aliased = $deploy.Output | Where-Object { $_ -match 'Aliased' } |
    Select-String -Pattern 'https://[A-Za-z0-9.-]+\.vercel\.app' | Select-Object -First 1
$urls = @($deploy.Output | Select-String -Pattern 'https://[A-Za-z0-9.-]+\.vercel\.app' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Select-Object -Unique)
$url = if ($production) { $production.Matches[0].Groups[1].Value } elseif ($aliased) { $aliased.Matches[0].Value } elseif ($urls) { $urls | Sort-Object Length | Select-Object -First 1 } else { $null }
if (-not $url) { Fail '  The app went online, but its link was not found. Open vercel.com to see it.' }

Set-Content -Path $linkFile -Value "Your Attendance App link:`r`n$url`r`n`r`nOpen it, create your class, then share the class link with your students." -Encoding UTF8
try { Set-Clipboard -Value $url } catch {}

Say ''
Say '  Done! Your app is online at:' Green
Say "  $url" Green
Say ''
Say '  The link was copied, and saved in "My app link.txt". Opening it now...' Green
Start-Process $url

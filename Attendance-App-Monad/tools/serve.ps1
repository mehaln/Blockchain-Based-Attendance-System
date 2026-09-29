# Opens the Attendance App on this computer at http://localhost:5510
# Started by double-clicking "1 - Open App on This Laptop.bat". Nothing needs to be installed.
param([int]$Port = 5510, [switch]$NoBrowser)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\attendance-app')).Path
$url = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try {
    $listener.Start()
} catch {
    Write-Host "The app already seems to be running. Opening it in your browser..." -ForegroundColor Yellow
    if (-not $NoBrowser) { Start-Process $url }
    exit 0
}

Write-Host ""
Write-Host "  Attendance App is running at $url" -ForegroundColor Green
Write-Host "  Keep this window open while you use the app. Close it when you are done."
Write-Host ""
if (-not $NoBrowser) { Start-Process $url }

$types = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
}

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response
    try {
        $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
        if ($path -eq '/') { $path = '/index.html' }
        $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
        if ($file.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
            $bytes = [IO.File]::ReadAllBytes($file)
            $ext = [IO.Path]::GetExtension($file).ToLower()
            $response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
            $response.Headers.Add('Cache-Control', 'no-cache')
        } else {
            $response.StatusCode = 404
            $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
        }
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
        # A browser closing a connection early is harmless.
    } finally {
        $response.Close()
    }
}

# 로컬 미리보기용 정적 서버 (node가 없는 환경용). /api 는 없으므로 앱이 "미리보기 모드"로 동작한다.
$root = Split-Path -Parent $PSScriptRoot
$l = New-Object Net.HttpListener
$l.Prefixes.Add('http://localhost:5173/')
$l.Start()
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json' }
while ($l.IsListening) {
  $c = $l.GetContext()
  $p = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath)
  if ($p -eq '/') { $p = '/index.html' }
  $f = Join-Path $root $p.TrimStart('/')
  if ((Test-Path $f -PathType Leaf) -and -not $p.StartsWith('/api')) {
    $b = [IO.File]::ReadAllBytes($f)
    $ext = [IO.Path]::GetExtension($f)
    $c.Response.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
    $c.Response.OutputStream.Write($b, 0, $b.Length)
  } else { $c.Response.StatusCode = 404 }
  $c.Response.Close()
}

# 홈 화면 아이콘 만들기 (node/python 없이 PowerShell + System.Drawing)
# 크림색 배경 · 초록 집 · 분홍 하트 · 작은 동전. 아이폰은 모서리를 알아서 둥글게 깎으므로 꽉 찬 정사각형으로 그린다.
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot

function Color($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

function Draw-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $u = $size / 100.0  # 100칸 격자 기준

  # 배경: 위는 크림, 아래는 살짝 복숭아빛
  $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, (Color '#fbf6ee'), (Color '#f6e3d6'), 90
  $g.FillRectangle($bg, $rect)

  $green = Color '#2f6b55'
  # 지붕 + 몸통을 하나의 둥근 모양으로
  $house = New-Object System.Drawing.Drawing2D.GraphicsPath
  $pts = @(
    (New-Object System.Drawing.PointF (22*$u), (47*$u)),
    (New-Object System.Drawing.PointF (50*$u), (22*$u)),
    (New-Object System.Drawing.PointF (78*$u), (47*$u)),
    (New-Object System.Drawing.PointF (73*$u), (47*$u)),
    (New-Object System.Drawing.PointF (73*$u), (78*$u)),
    (New-Object System.Drawing.PointF (27*$u), (78*$u)),
    (New-Object System.Drawing.PointF (27*$u), (47*$u))
  )
  $house.AddPolygon($pts)
  $pen = New-Object System.Drawing.Pen $green, (8*$u)
  $pen.LineJoin = 'Round'
  $g.FillPath((New-Object System.Drawing.SolidBrush $green), $house)
  $g.DrawPath($pen, $house)

  # 굴뚝
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $green), (63*$u), (24*$u), (8*$u), (16*$u))

  # 하트 (두 원 + 아래 꼭짓점)
  $pink = New-Object System.Drawing.SolidBrush (Color '#f29bb5')
  $cx = 50*$u; $cy = 58*$u; $r = 7.2*$u
  $g.FillEllipse($pink, ($cx - 2*$r + 0.6*$u), ($cy - $r), (2*$r), (2*$r))
  $g.FillEllipse($pink, ($cx - 0.6*$u), ($cy - $r), (2*$r), (2*$r))
  $tri = @(
    (New-Object System.Drawing.PointF ($cx - 2*$r + 1.2*$u), ($cy + 2.2*$u)),
    (New-Object System.Drawing.PointF ($cx + 2*$r - 1.2*$u), ($cy + 2.2*$u)),
    (New-Object System.Drawing.PointF $cx, ($cy + 2*$r + 3.5*$u))
  )
  $g.FillPolygon($pink, $tri)

  # 오른쪽 아래 작은 동전
  $gold = New-Object System.Drawing.SolidBrush (Color '#e8b64c')
  $g.FillEllipse($gold, (70*$u), (68*$u), (18*$u), (18*$u))
  $ring = New-Object System.Drawing.Pen (Color '#c99223'), (1.8*$u)
  $g.DrawEllipse($ring, (73*$u), (71*$u), (12*$u), (12*$u))

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Item -ItemType Directory -Force (Join-Path $root 'icons') | Out-Null
Draw-Icon 180 (Join-Path $root 'icons/apple-touch-icon.png')
Draw-Icon 192 (Join-Path $root 'icons/icon-192.png')
Draw-Icon 512 (Join-Path $root 'icons/icon-512.png')
Draw-Icon 64  (Join-Path $root 'icons/favicon.png')
'done'

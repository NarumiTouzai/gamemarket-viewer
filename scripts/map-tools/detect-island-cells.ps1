# 島の中のコマの位置を公式マップ画像から読み取る
#  島の箱の中で、右の列と左の列それぞれを上から下へ調べ、暗い線で区切られた塗りの部分を1コマとして数える
#  番号は 右の列の上から 1,2,3… → 続けて左の列の上から
param([string]$sp)
Add-Type -AssemblyName System.Drawing
$islands = Get-Content "$sp\islands.json" -Raw | ConvertFrom-Json
$result = [ordered]@{}
foreach ($day in 1, 2) {
  $bmp = [System.Drawing.Bitmap]::new("$sp\day$day.jpg")
  $rect = [System.Drawing.Rectangle]::new(0, 0, $bmp.Width, $bmp.Height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $W = $bmp.Width; $stride = $data.Stride; $px = [byte[]]::new($stride * $bmp.Height)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length); $bmp.UnlockBits($data); $bmp.Dispose()
  $s = $W / 2000
  function Lum([int]$x, [int]$y) { $o = $y * $stride + $x * 3; return ($px[$o] + $px[$o + 1] + $px[$o + 2]) / 3 }
  # 列を上から下へ見て、暗い線の間の塗り（ある程度の高さのもの）をコマとして返す
  function Cells([double]$fx, $box) {
    $x = [int](($box[0] + ($box[2] - $box[0]) * $fx) * $s)
    $y0 = [int]($box[1] * $s); $y1 = [int]($box[3] * $s)
    $cells = @(); $start = -1
    for ($y = $y0; $y -le $y1; $y++) {
      $dark = ((Lum ($x - 1) $y) -lt 110) -or ((Lum $x $y) -lt 110) -or ((Lum ($x + 1) $y) -lt 110)
      if (-not $dark -and $start -lt 0) { $start = $y }
      if ($dark -and $start -ge 0) { if (($y - $start) -ge 7) { $cells += , @($start, ($y - 1)) }; $start = -1 }
    }
    # 本物のコマは左右が縦の線で囲まれている。島の端やブロックの間のすき間（左右に線がない）は除く
    $lim = [int](16 * $s / 2.17)
    return , ($cells | ? {
      $ym = [int](($_[0] + $_[1]) / 2)
      $hasL = $false; for ($d = 1; $d -le $lim; $d++) { if ((Lum ($x - $d) $ym) -lt 110) { $hasL = $true; break } }
      $hasR = $false; for ($d = 1; $d -le $lim; $d++) { if ((Lum ($x + $d) $ym) -lt 110) { $hasR = $true; break } }
      $hasL -and $hasR
    })
  }
  # 列の左右の端（縦の線）を、コマの真ん中の高さで探す
  function ColX([double]$fx, $box, $cell) {
    $x = [int](($box[0] + ($box[2] - $box[0]) * $fx) * $s); $y = [int](($cell[0] + $cell[1]) / 2)
    $l = $x; while ($l -gt $x - 40 -and (Lum $l $y) -ge 110) { $l-- }
    $r = $x; while ($r -lt $x + 40 -and (Lum $r $y) -ge 110) { $r++ }
    return @([Math]::Round($l / $s, 1), [Math]::Round($r / $s, 1))
  }
  foreach ($isl in ($islands | ? day -eq $day)) {
    $right = Cells 0.61 $isl.box; $left = Cells 0.37 $isl.box
    $n = $right.Count + $left.Count
    $ok = ($n -ge $isl.max) -and ($n - $isl.max -le 3) -and $right.Count -gt 0 -and $left.Count -gt 0
    $key = "$day" + ":" + $isl.island
    "{0,-5} 右{1,3} + 左{2,3} = {3,3}  データ上の最大番号 {4,3}  {5}" -f $key, $right.Count, $left.Count, $n, $isl.max, ($(if ($ok) { "OK" } else { "×（島単位のまま）" }))
    if ($true) {
      $result[$key] = [ordered]@{
        rx = (ColX 0.61 $isl.box $right[0]); lx = (ColX 0.37 $isl.box $left[0])
        r = @($right | % { , @([Math]::Round($_[0] / $s, 1), [Math]::Round($_[1] / $s, 1)) })
        l = @($left | % { , @([Math]::Round($_[0] / $s, 1), [Math]::Round($_[1] / $s, 1)) })
      }
    }
  }
}
$result | ConvertTo-Json -Depth 6 -Compress | Set-Content "$sp\cells.json" -Encoding utf8

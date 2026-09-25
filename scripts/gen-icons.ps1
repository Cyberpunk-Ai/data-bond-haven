Add-Type -AssemblyName System.Drawing

$src = 'C:\Users\ADMIN\AppData\Roaming\Qoder\SharedClientCache\cache\images\4867eb2a\download (2)-c57c16ee.png'
$outDir = Join-Path $PSScriptRoot '..\public'
$outDir = (Resolve-Path $outDir).Path

$img = [System.Drawing.Image]::FromFile($src)
$side = [Math]::Min($img.Width, $img.Height)
$cropX = [int](($img.Width - $side) / 2)
$cropY = [int](($img.Height - $side) / 2)

function Make-Square([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $g.DrawImage($img, $rect, $cropX, $cropY, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  return $bmp
}

function Save-Png([int]$size, [string]$name) {
  $bmp = Make-Square $size
  $path = Join-Path $outDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "wrote $name ($size x $size)"
}

Save-Png 512 'icon-512.png'
Save-Png 192 'icon-192.png'
Save-Png 180 'apple-touch-icon.png'
Save-Png 512 'logo.png'

# favicon.ico from a 32x32 render
$fb = Make-Square 32
$hicon = $fb.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hicon)
$icoPath = Join-Path $outDir 'favicon.ico'
$fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$icon.Save($fs)
$fs.Close()
$icon.Dispose()
$fb.Dispose()
"wrote favicon.ico"

$img.Dispose()
'done'

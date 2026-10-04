<#
  Builds public/og-image.png - the 1200x630 link-preview card.

  Why a real card: every platform that renders a shared link (X, WhatsApp,
  Facebook, LinkedIn, Telegram, Slack, Discord) wants og:image at 1.91:1. The
  site's only brand mark is a 512x512 square, so those services letterbox it and
  the preview comes out as a small mark floating in a band of background colour.
  This composes the same mark at card ratio with the name and tagline.

  The mark is never redrawn: it is scaled from public/logo.png, so the card
  cannot drift from the app icon.

  Brand text is baked into bytes, so it arrives as parameters that default to
  the same strings src/lib/config.ts falls back to. Re-run with -Name/-Tagline
  after changing VITE_APP_NAME:

    powershell -ExecutionPolicy Bypass -File scripts/build-og-image.ps1
    powershell -ExecutionPolicy Bypass -File scripts/build-og-image.ps1 -Name "Other" -Tagline "..."
#>
param(
  [string]$Name = "Spaces1",
  [string]$Tagline = "Where creators gather, talk and get paid.",
  # Left empty on purpose. Windows PowerShell 5.1 decodes a .ps1 with no BOM as
  # ANSI, so a literal middot written into this file reaches the canvas as two
  # garbage characters. The source stays pure ASCII and the glyph is built from
  # its code point at runtime, which no reader can mis-decode.
  [string]$Features = ""
)

if (-not $Features) {
  $sep = " " + [string][char]0x00B7 + " "
  $Features = @("Live audio spaces", "Stories", "Messages", "Creator payouts") -join $sep
}

Add-Type -AssemblyName System.Drawing

$publicDir = (Resolve-Path (Join-Path $PSScriptRoot '..\public')).Path
$logoPath = Join-Path $publicDir 'logo.png'
$outPath = Join-Path $publicDir 'og-image.png'
if (-not (Test-Path $logoPath)) { throw "$logoPath is missing; the card is built from the real mark." }

$W = 1200
$H = 630
$Margin = 72
$Badge = 264
$BadgeRadius = 56
$Gap = 56

# sRGB equivalents of the app's default-accent oklch brand tokens (see
# src/lib/theme-colors.ts, which derives them from src/styles.css).
$InkTop = [System.Drawing.Color]::FromArgb(255, 8, 3, 16)
$InkBottom = [System.Drawing.Color]::FromArgb(255, 34, 7, 60)
$White = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$Muted = [System.Drawing.Color]::FromArgb(255, 209, 201, 226)
$Lilac = [System.Drawing.Color]::FromArgb(255, 163, 124, 255)
$Brand = [System.Drawing.Color]::FromArgb(255, 127, 34, 254)
$Transparent = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)

$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# --- ground: near-black, with the brand violet lifting off the bottom edge ---
$ground = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($W, $H)),
  $InkTop,
  $InkBottom
)
$g.FillRectangle($ground, 0, 0, $W, $H)
$ground.Dispose()

$sweepHeight = 220
$sweepBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, ($H - $sweepHeight))),
  (New-Object System.Drawing.Point(0, $H)),
  $Transparent,
  [System.Drawing.Color]::FromArgb(64, $Brand.R, $Brand.G, $Brand.B)
)
$g.FillRectangle($sweepBrush, 0, ($H - $sweepHeight), $W, $sweepHeight)
$sweepBrush.Dispose()

# --- the mark, in a rounded tile (its own black field becomes the tile) ------
$tileRect = New-Object System.Drawing.Rectangle($Margin, [int](($H - $Badge) / 2), $Badge, $Badge)
$tilePath = New-Object System.Drawing.Drawing2D.GraphicsPath
$tilePath.AddArc($tileRect.X, $tileRect.Y, $BadgeRadius, $BadgeRadius, 180, 90)
$tilePath.AddArc($tileRect.Right - $BadgeRadius, $tileRect.Y, $BadgeRadius, $BadgeRadius, 270, 90)
$tilePath.AddArc($tileRect.Right - $BadgeRadius, $tileRect.Bottom - $BadgeRadius, $BadgeRadius, $BadgeRadius, 0, 90)
$tilePath.AddArc($tileRect.X, $tileRect.Bottom - $BadgeRadius, $BadgeRadius, $BadgeRadius, 90, 90)
$tilePath.CloseFigure()

$logo = [System.Drawing.Image]::FromFile($logoPath)
$state = $g.Save()
$g.SetClip($tilePath)
$g.FillRectangle([System.Drawing.Brushes]::Black, $tileRect)
$g.DrawImage($logo, $tileRect)
$g.Restore($state)
$tilePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, $Brand.R, $Brand.G, $Brand.B), 3)
$g.DrawPath($tilePen, $tilePath)
$tilePen.Dispose()
$tilePath.Dispose()
$logo.Dispose()

# --- wordmark + copy, each line stepped down until it fits the column --------
$textX = $Margin + $Badge + $Gap
$textMax = [float]($W - $Margin - $textX)

$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Near
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Near

function New-Font([float]$size, [bool]$bold) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  return New-Object System.Drawing.Font('Segoe UI', $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

# Draws one left-aligned line at $y and returns the y just below it. A name or
# tagline longer than the defaults shrinks instead of running off the card.
function Draw-Line {
  param([string]$Text, [float]$Size, [bool]$Bold, [System.Drawing.Color]$Color, [float]$Y)

  $measure = $null
  $font = $null
  while ($true) {
    if ($font) { $font.Dispose() }
    $font = New-Font $Size $Bold
    $measure = $g.MeasureString($Text, $font, [System.Drawing.PointF]::Empty, $fmt)
    if ($measure.Width -le $textMax -or $Size -le 12) { break }
    $Size = $Size * 0.94
  }
  $brush = New-Object System.Drawing.SolidBrush $Color
  $g.DrawString($Text, $font, $brush, [float]$textX, $Y)
  $brush.Dispose()
  $font.Dispose()
  return ($Y + $measure.Height)
}

$cursor = [float](($H - 292) / 2)
$cursor = Draw-Line -Text $Name -Size 104 -Bold $true -Color $White -Y $cursor
$cursor = Draw-Line -Text $Tagline -Size 40 -Bold $false -Color $Muted -Y ($cursor + 12)
$cursor = Draw-Line -Text $Features -Size 27 -Bold $false -Color $Lilac -Y ($cursor + 16)
"copy block ends at y=$([int]$cursor) of $H"

$fmt.Dispose()
$g.Dispose()
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"wrote $outPath ($W x $H)"

<#
  Builds public/og-image.png - the 1200x630 link-preview card.

  Why a real card: every platform that renders a shared link (X, WhatsApp,
  Facebook, LinkedIn, Telegram, Slack, Discord) wants og:image at 1.91:1. The
  site's only brand mark is a 512x512 square, so those services letterbox it and
  the preview comes out as a small mark floating in a band of background colour.
  This composes that same mark at card ratio.

  The card is the logo ALONE - no wordmark, no tagline. The mark is the brand's
  own white glyph on pure black, laid straight onto the brand's own black field,
  so its square edges dissolve and what reads is one clean, centred logo with
  nothing to make it look busy or (on a dark previewer) half-broken.

  The mark is never redrawn: it is scaled down from public/logo.png (512 -> a
  smaller box), so it stays sharp and cannot drift from the app icon.

  Re-run after changing the source mark:

    powershell -ExecutionPolicy Bypass -File scripts/build-og-image.ps1
#>

Add-Type -AssemblyName System.Drawing

# The source stays pure ASCII on purpose. Windows PowerShell 5.1 decodes a .ps1
# with no BOM as ANSI, so any literal non-ASCII glyph written into this file
# would reach the canvas as two garbage characters. Keep it ASCII. There is no
# text drawn at all now, so there is nothing to mis-encode regardless.

$publicDir = (Resolve-Path (Join-Path $PSScriptRoot '..\public')).Path
$logoPath = Join-Path $publicDir 'logo.png'
$outPath = Join-Path $publicDir 'og-image.png'
if (-not (Test-Path $logoPath)) { throw "$logoPath is missing; the card is built from the real mark." }

$W = 1200
$H = 630
# The mark sits centred and fills most of the shorter (630px) axis: big enough
# to read as the whole card, small enough to keep clear black margins so a
# letterbox on any platform just extends the same field invisibly.
$Mark = 420

$Black = [System.Drawing.Color]::FromArgb(255, 0, 0, 0)

$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# --- ground: the brand's own flat black -------------------------------------
$g.Clear($Black)

# --- the mark, centred ------------------------------------------------------
# logo.png is a black tile with the white glyph, so drawing it straight onto the
# black ground (no tile, no border) leaves only the logo visible.
$logo = [System.Drawing.Image]::FromFile($logoPath)
$markRect = New-Object System.Drawing.Rectangle(
  [int](($W - $Mark) / 2),
  [int](($H - $Mark) / 2),
  $Mark,
  $Mark
)
$g.DrawImage($logo, $markRect)
$logo.Dispose()

"glyph box: $($markRect.X),$($markRect.Y) $($Mark)x$($Mark) (centred in $W x $H)"

$g.Dispose()
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"wrote $outPath ($W x $H)"

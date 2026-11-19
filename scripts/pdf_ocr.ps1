param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [string]$Pages = '',
  [int]$Dpi = 200,
  [string]$Lang = 'zh-Hans-CN',
  [string]$OutDir = '',
  [string]$OutJson = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
$asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]

function AwaitOp($op, $type) {
  $m = $asTaskOp.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}
function AwaitAct($act) {
  $t = $asTaskAct.Invoke($null, @($act))
  $t.Wait(-1) | Out-Null
}

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
[void][Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
$doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])

$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($Lang))) } catch { $engine = $null }
if (-not $engine) {
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
}
if (-not $engine) {
  Write-Output '{"ok":false,"error":"OCR 引擎不可用（缺语言包）"}'
  exit 3
}

$total = [int]$doc.PageCount
if ($Pages -and $Pages.Trim()) {
  $want = @()
  foreach ($p in ($Pages -split ',')) {
    $n = 0
    if ([int]::TryParse($p.Trim(), [ref]$n)) { if ($n -ge 1 -and $n -le $total) { $want += $n } }
  }
} else {
  $want = 1..$total
}

if ($OutDir -and -not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$results = @()
foreach ($n in $want) {
  $page = $doc.GetPage([uint32]($n - 1))
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $w = [math]::Round($page.Size.Width / 72.0 * $Dpi)
  $h = [math]::Round($page.Size.Height / 72.0 * $Dpi)
  if ($w -gt 0) { $opts.DestinationWidth = [uint32]$w }
  if ($h -gt 0) { $opts.DestinationHeight = [uint32]$h }

  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAct ($page.RenderToStreamAsync($stream, $opts))
  $stream.Seek(0) | Out-Null

  $decoder = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = AwaitOp ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  if ($OutDir) {
    $png = Join-Path $OutDir ("page-{0:D3}.png" -f $n)
    $sfile = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
    $os = AwaitOp ($sfile.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])
    $enc = AwaitOp ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync([Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId, $os)) ([Windows.Graphics.Imaging.BitmapEncoder])
    $enc.SetSoftwareBitmap($bmp)
    AwaitAct ($enc.FlushAsync())
    $os.Dispose()
  }

  $res = AwaitOp ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($ln in $res.Lines) { $lines += $ln.Text }
  $text = ($lines -join "`n")
  $results += [pscustomobject]@{
    page  = $n
    chars = $text.Length
    text  = $text
  }
  $bmp.Dispose()
  $stream.Dispose()
  $page.Dispose()
}

$payload = [pscustomobject]@{
  ok     = $true
  pages  = $total
  lang   = $Lang
  dpi    = $Dpi
  result = $results
}
$json = $payload | ConvertTo-Json -Depth 5 -Compress
if ($OutJson) {
  $dir = Split-Path -Parent $OutJson
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($OutJson, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('OK ' + $OutJson)
} else {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $json
}

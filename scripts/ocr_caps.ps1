try {
  [void][Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime]
  [void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $langs = @()
  foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $langs += $l.LanguageTag }
  $hasPdf = $true
  $payload = [pscustomobject]@{ ok = $true; langs = $langs; pdf = $hasPdf }
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output ($payload | ConvertTo-Json -Compress)
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}

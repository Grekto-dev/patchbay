# Removes the local CA from the current user's trust store. The proxy keeps
# serving HTTPS afterwards, but Claude Desktop will refuse it with
# ERR_CERT_AUTHORITY_INVALID until the CA is trusted again.
$ErrorActionPreference = "Stop"

# The subject comes from the CA on disk when it is still there, so a renamed
# CA is still found; otherwise fall back to the name the generator uses.
$subject = "CN=Claude-DS Proxy CA, O=Local"
$caPath = Join-Path $PSScriptRoot "ca-cert.pem"
if (Test-Path $caPath) {
    $pem = Get-Content $caPath -Raw
    $der = [Convert]::FromBase64String((($pem -replace '-----[A-Z ]+-----', '') -replace '\s', ''))
    $ca  = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, $der)
    $subject = $ca.Subject
}

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
$store.Open('ReadWrite')
$mine = @($store.Certificates | Where-Object { $_.Subject -eq $subject })

foreach ($cert in $mine) {
    $store.Remove($cert)
    Write-Output "Removed: $($cert.Thumbprint)  (valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))"
}
$store.Close()

if ($mine.Count -eq 0) {
    Write-Output "Nothing to remove: no certificate with subject '$subject' in CurrentUser\Root."
} else {
    Write-Output ""
    Write-Output "$($mine.Count) certificate(s) removed from CurrentUser\Root."
    Write-Output "The PEM files under certs\ are untouched - reinstall from the panel at any time."
}

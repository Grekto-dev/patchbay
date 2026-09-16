# Trusts the local CA for the current user, so Claude Desktop accepts the
# proxy's HTTPS gateway. No administrator rights are needed: the certificate
# goes into CurrentUser\Root, and Windows asks you to confirm.
$ErrorActionPreference = "Stop"

$caPath = Join-Path $PSScriptRoot "ca-cert.pem"
if (-not (Test-Path $caPath)) {
    Write-Error "ca-cert.pem not found. Generate the certificates first."
    exit 1
}

$pem = Get-Content $caPath -Raw
$der = [Convert]::FromBase64String((($pem -replace '-----[A-Z ]+-----', '') -replace '\s', ''))
$ca  = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, $der)

$isCa = $false
foreach ($ext in $ca.Extensions) {
    if ($ext -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]) {
        $isCa = $ext.CertificateAuthority
    }
}
if (-not $isCa) {
    Write-Warning "This certificate is not marked CA:TRUE. Claude Desktop will still refuse the chain."
}

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
$store.Open('ReadWrite')

# An older CA of ours goes first. It carries the same subject and a stale key,
# and leaving it in place is how a freshly reissued chain still gets rejected.
$stale = @($store.Certificates | Where-Object { $_.Subject -eq $ca.Subject -and $_.Thumbprint -ne $ca.Thumbprint })
foreach ($old in $stale) {
    $store.Remove($old)
    Write-Output "Removed stale CA: $($old.Thumbprint)"
}

$store.Add($ca)
$store.Close()

Write-Output "CA trusted for the current user ($env:USERNAME)."
Write-Output "Store:       CurrentUser\Root"
Write-Output "Subject:     $($ca.Subject)"
Write-Output "Thumbprint:  $($ca.Thumbprint)"
Write-Output "Valid until: $($ca.NotAfter.ToString('yyyy-MM-dd'))"
Write-Output ""
Write-Output "Restart Claude Desktop so it picks up the new chain."

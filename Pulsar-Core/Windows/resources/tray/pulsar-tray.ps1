# Pulsar — panel zasobnika (uruchamiany przez Pulsara; nie uruchamiaj ręcznie).
# Kompiluje PulsarTray.cs (raz; wynik zapamiętany jako DLL z sumą kontrolną w nazwie) i uruchamia panel.
param(
  [string]$Dir = $PSScriptRoot,
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
try {
  $src = [System.IO.File]::ReadAllText((Join-Path $Dir 'PulsarTray.cs'), [System.Text.Encoding]::UTF8)
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $hash = ([System.BitConverter]::ToString($md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($src)))).Replace('-', '').Substring(0, 12)
  $dll = Join-Path $Dir ('PulsarTray-' + $hash + '.dll')
  $refs = @('System.Windows.Forms', 'System.Drawing')
  $loaded = $false
  if (Test-Path -LiteralPath $dll) {
    try { Add-Type -LiteralPath $dll; $loaded = $true } catch { $loaded = $false }
  }
  if (-not $loaded) {
    try {
      # stare wersje DLL (inna suma) — sprzątanie, błędy (plik w użyciu) nieistotne
      Get-ChildItem -LiteralPath $Dir -Filter 'PulsarTray-*.dll' -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop } catch {} }
      Add-Type -TypeDefinition $src -Language CSharp -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library -IgnoreWarnings
      Add-Type -LiteralPath $dll
    } catch {
      # folder tylko do odczytu itp. — kompilacja w pamięci
      Add-Type -TypeDefinition $src -Language CSharp -ReferencedAssemblies $refs -IgnoreWarnings
    }
  }
  [PulsarTray.Host]::Run($Dir, $ParentPid)
} catch {
  $msg = ($_.Exception.Message -replace "[\r\n]+", ' ')
  try {
    $out = [System.Console]::OpenStandardOutput()
    $b = [System.Text.Encoding]::UTF8.GetBytes('error:' + $msg + "`n")
    $out.Write($b, 0, $b.Length); $out.Flush()
  } catch {}
  exit 1
}

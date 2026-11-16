# Pulsar's local Discord Rich Presence IPC client. No Discord token or network API.
$ErrorActionPreference = 'Stop'
$script:utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $script:utf8
[Console]::OutputEncoding = $script:utf8
$script:pipe = $null
$script:sequence = 0

function Write-Status([bool]$Ok, [string]$Message) {
  $line = @{ type = 'status'; ok = $Ok; message = $Message } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

function Format-Clock([double]$Seconds) {
  $total = [Math]::Max(0, [int][Math]::Floor($Seconds))
  $hours = [int][Math]::Floor($total / 3600)
  $minutes = [int][Math]::Floor(($total % 3600) / 60)
  $remaining = $total % 60
  if ($hours -gt 0) { return ('{0}:{1:00}:{2:00}' -f $hours, $minutes, $remaining) }
  return ('{0}:{1:00}' -f $minutes, $remaining)
}

function Read-Exact($Stream, [int]$Count) {
  $buffer = New-Object byte[] $Count
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($buffer, $offset, $Count - $offset)
    if ($read -le 0) { throw 'Discord IPC closed' }
    $offset += $read
  }
  return ,$buffer
}

function Read-Packet($Stream) {
  $header = Read-Exact $Stream 8
  $opcode = [BitConverter]::ToInt32($header, 0)
  $length = [BitConverter]::ToInt32($header, 4)
  if ($length -lt 0 -or $length -gt 1048576) { throw 'Invalid Discord IPC frame length' }
  $bytes = Read-Exact $Stream $length
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  $payload = if ($json) { $json | ConvertFrom-Json } else { @{} }
  return @{ opcode = $opcode; payload = $payload }
}

function Write-Packet($Stream, [int]$Opcode, $Payload) {
  $json = $Payload | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $header = [BitConverter]::GetBytes([int]$Opcode)
  $length = [BitConverter]::GetBytes([int]$bytes.Length)
  $Stream.Write($header, 0, $header.Length)
  $Stream.Write($length, 0, $length.Length)
  $Stream.Write($bytes, 0, $bytes.Length)
  $Stream.Flush()
}

function Close-Pipe {
  if ($script:pipe) { try { $script:pipe.Dispose() } catch {} }
  $script:pipe = $null
}

function Connect-Discord([string]$AppId) {
  if ($script:pipe -and $script:appId -eq $AppId) { return }
  Close-Pipe
  $handshakeErrors = @()
  $lastPipeError = ''
  for ($i = 0; $i -lt 10; $i++) {
    $candidate = New-Object System.IO.Pipes.NamedPipeClientStream('.', ('discord-ipc-' + $i), [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None)
    $connected = $false
    try {
      $candidate.Connect(1000)
      $connected = $true
      Write-Packet $candidate 0 @{ v = 1; client_id = $AppId }
      $reply = Read-Packet $candidate
      if ($reply.opcode -ne 1 -or $reply.payload.evt -ne 'READY') {
        $evt = if ($reply.payload -and $reply.payload.evt) { [string]$reply.payload.evt } else { 'none' }
        throw ('RPC handshake rejected on discord-ipc-' + $i + ' (opcode=' + $reply.opcode + ', evt=' + $evt + ')')
      }
      $script:pipe = $candidate
      $script:appId = $AppId
      return
    } catch {
      $detail = $_.Exception.GetBaseException().Message
      if ($connected) { $handshakeErrors += ('discord-ipc-' + $i + ': ' + $detail) }
      elseif (-not $lastPipeError) { $lastPipeError = 'discord-ipc-' + $i + ': ' + $detail }
      try { $candidate.Dispose() } catch {}
    }
  }
  if ($handshakeErrors.Count -gt 0) {
    throw ('Discord IPC pipe was found, but RPC handshake failed: ' + ($handshakeErrors -join '; '))
  }
  throw ('Discord desktop IPC not found; open the Discord desktop app (last pipe error: ' + $lastPipeError + ')')
}

function Send-Activity([string]$AppId, $Activity) {
  Connect-Discord $AppId
  $script:sequence++
  Write-Packet $script:pipe 1 @{
    cmd = 'SET_ACTIVITY'
    args = @{ pid = $PID; activity = $Activity }
    nonce = [string]$script:sequence
  }
  while ($true) {
    $reply = Read-Packet $script:pipe
    if ($reply.opcode -eq 3) { Write-Packet $script:pipe 4 $reply.payload; continue }
    if ($reply.opcode -eq 2) { throw 'Discord closed the Rich Presence connection' }
    if ($reply.opcode -eq 1 -and $reply.payload.cmd -eq 'SET_ACTIVITY') {
      if ($reply.payload.evt -eq 'ERROR') { throw [string]$reply.payload.data.message }
      return
    }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    switch ([string]$request.cmd) {
      'exit' { Close-Pipe; return }
      'clear' {
        $clearId = if ($request.appId) { [string]$request.appId } else { [string]$script:appId }
        if ($script:pipe) { Send-Activity $clearId $null }
        Write-Status $true 'Discord Rich Presence cleared'
        Close-Pipe
        continue
      }
      'update' {
        $appId = [string]$request.appId
        if ($appId -notmatch '^\d{17,20}$') { throw 'Enter a valid Discord Application ID' }
        $title = [string]$request.title
        if (-not $title) { $title = 'Pulsar' }
        if ($title.Length -gt 128) { $title = $title.Substring(0, 128) }
        $artist = [string]$request.artist
        if ($artist.Length -gt 128) { $artist = $artist.Substring(0, 128) }
        $activity = @{ type = 2; details = $title; state = $artist; instance = $false }
        $position = [Math]::Max(0.0, [double]$request.position)
        $duration = [Math]::Max(0.0, [double]$request.duration)
        if ($request.playing) {
          $start = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - ($position * 1000))
          $activity.timestamps = @{ start = $start }
          if ($duration -gt 0) { $activity.timestamps.end = $start + [int64]($duration * 1000) }
        } else {
          $clock = Format-Clock $position
          if ($duration -gt 0) { $clock += ' / ' + (Format-Clock $duration) }
          $artistLimit = [Math]::Max(0, 110 - $clock.Length)
          if ($artist.Length -gt $artistLimit) { $artist = $artist.Substring(0, $artistLimit) }
          $pausedParts = @('Paused')
          if ($artist) { $pausedParts += $artist }
          $pausedParts += $clock
          $activity.state = ($pausedParts -join ' - ').Substring(0, [Math]::Min(128, ($pausedParts -join ' - ').Length))
        }
        Send-Activity $appId $activity
        Write-Status $true 'Connected to Discord'
      }
      default { }
    }
  } catch {
    Close-Pipe
    Write-Status $false $_.Exception.Message
  }
}
Close-Pipe

#!/usr/bin/env python3
"""Small local Discord Rich Presence IPC client for Pulsar (no Discord token)."""
import glob
import json
import os
import socket
import struct
import sys
import time

OP_HANDSHAKE = 0
OP_FRAME = 1
OP_CLOSE = 2
OP_PING = 3
OP_PONG = 4


def encode_frame(opcode, payload):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return struct.pack("<II", opcode, len(body)) + body


def read_exact(sock, size):
    parts = []
    while size:
        part = sock.recv(size)
        if not part:
            raise ConnectionError("Discord IPC closed")
        parts.append(part)
        size -= len(part)
    return b"".join(parts)


def read_packet(sock):
    opcode, length = struct.unpack("<II", read_exact(sock, 8))
    body = read_exact(sock, length)
    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = {}
    return opcode, payload


def socket_candidates():
    explicit = os.environ.get("DISCORD_IPC_PATH")
    if explicit:
        yield explicit
    # Discord resolves its socket in these temporary/runtime directories first.
    # In particular, current desktop clients commonly put it under XDG_RUNTIME_DIR,
    # not ~/.config/discord (the older fallback below).
    runtime_dirs = [
        os.environ.get("XDG_RUNTIME_DIR"),
        os.environ.get("TMPDIR"),
        os.environ.get("TMP"),
        os.environ.get("TEMP"),
        "/tmp",
    ]
    found = set()
    for directory in runtime_dirs:
        if not directory:
            continue
        for path in glob.glob(os.path.join(directory, "discord-ipc-*")):
            if path not in found:
                found.add(path)
                yield path

    config = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    roots = [config]
    roots.extend([
        os.path.join(os.path.expanduser("~"), ".var", "app", "com.discordapp.Discord", "config"),
        os.path.join(os.path.expanduser("~"), ".var", "app", "com.discordapp.DiscordCanary", "config"),
    ])
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        roots.extend(glob.glob(os.path.join(runtime, "app", "com.discordapp.*")))
    names = ("discord", "discordcanary", "discordptb", "vesktop", "armcord")
    for root in roots:
        for name in names:
            directory = os.path.join(root, name)
            for path in glob.glob(os.path.join(directory, "discord-ipc-*")):
                if path not in found:
                    found.add(path)
                    yield path
        for path in glob.glob(os.path.join(root, "discord-ipc-*")):
            if path not in found:
                found.add(path)
                yield path


class DiscordIPC:
    def __init__(self):
        self.sock = None
        self.client_id = None
        self.sequence = 0

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        self.client_id = None

    def connect(self, client_id):
        if self.sock and self.client_id == client_id:
            return
        self.close()
        errors = []
        for path in socket_candidates():
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.settimeout(5)
            try:
                client.connect(path)
                client.sendall(encode_frame(OP_HANDSHAKE, {"v": 1, "client_id": client_id}))
                opcode, reply = read_packet(client)
                if opcode != OP_FRAME or reply.get("evt") != "READY":
                    raise ConnectionError("Discord RPC handshake was rejected")
                client.settimeout(10)
                self.sock = client
                self.client_id = client_id
                return
            except (OSError, ConnectionError, ValueError) as exc:
                errors.append(str(exc))
                client.close()
        raise ConnectionError("Discord desktop IPC not found; open the Discord desktop app")

    def send(self, client_id, activity):
        self.connect(client_id)
        self.sequence += 1
        self.sock.sendall(encode_frame(OP_FRAME, {
            "cmd": "SET_ACTIVITY",
            "args": {"pid": os.getpid(), "activity": activity},
            "nonce": str(self.sequence),
        }))
        # Read the RPC response; answer IPC pings in case Discord sends one first.
        while True:
            opcode, reply = read_packet(self.sock)
            if opcode == OP_PING:
                self.sock.sendall(encode_frame(OP_PONG, reply))
                continue
            if opcode == OP_FRAME and reply.get("cmd") == "SET_ACTIVITY":
                if reply.get("evt") == "ERROR":
                    raise RuntimeError(str(reply.get("data", {}).get("message", "Discord rejected presence")))
                return
            if opcode == OP_CLOSE:
                raise ConnectionError("Discord closed the Rich Presence connection")


def format_clock(seconds):
    total = max(0, int(float(seconds or 0)))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"


def make_activity(message):
    title = str(message.get("title") or "Pulsar")[:128]
    artist = str(message.get("artist") or "")[:128]
    details = title
    state = artist
    activity = {"type": 2, "details": details, "state": state, "instance": False}
    position = max(0.0, float(message.get("position") or 0))
    duration = max(0.0, float(message.get("duration") or 0))
    if message.get("playing"):
        start = int((time.time() - position) * 1000)
        activity["timestamps"] = {"start": start}
        if duration > 0:
            activity["timestamps"]["end"] = start + int(duration * 1000)
    else:
        clock = format_clock(position)
        if duration > 0:
            clock += " / " + format_clock(duration)
        artist_limit = max(0, 110 - len(clock))
        activity["state"] = ("Paused - " + artist[:artist_limit] + " - " + clock).strip(" -")[:128]
    return activity


def report(ok, message):
    print(json.dumps({"type": "status", "ok": bool(ok), "message": str(message)}, ensure_ascii=False), flush=True)


def main():
    rpc = DiscordIPC()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            command = request.get("cmd")
            if command == "exit":
                rpc.close()
                break
            if command == "clear":
                if rpc.sock:
                    rpc.send(str(request.get("appId") or rpc.client_id), None)
                report(True, "Discord Rich Presence cleared")
                rpc.close()
                continue
            if command != "update":
                continue
            client_id = str(request.get("appId") or "")
            if not client_id.isdigit() or not 17 <= len(client_id) <= 20:
                raise ValueError("Enter a valid Discord Application ID")
            rpc.send(client_id, make_activity(request))
            report(True, "Connected to Discord")
        except (ValueError, TypeError, OSError, ConnectionError, RuntimeError) as exc:
            rpc.close()
            report(False, str(exc))
    rpc.close()


if __name__ == "__main__":
    main()

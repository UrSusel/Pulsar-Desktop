#!/usr/bin/env python3
"""
neu.py — rozpakowywanie i pakowanie plików resources.neu (format asar
używany przez Neutralino.js) bez Node.js i bez neu CLI.

Użycie:
  python tools/neu.py unpack resources.neu app        # .neu -> folder
  python tools/neu.py pack   app resources.neu        # folder -> .neu
  python tools/neu.py verify resources.neu            # sprawdza sumy SHA-256
  python tools/neu.py list   resources.neu            # lista plików

Przy pakowaniu brane są: <folder>/neutralino.config.json oraz cały
<folder>/resources/ (tak samo jak robi to `neu build`). Pliki są
sortowane alfabetycznie, więc wynik jest powtarzalny — spakowanie
rozpakowanego archiwum daje plik identyczny bajt w bajt.
"""
import hashlib
import json
import os
import struct
import sys

BLOCK_SIZE = 4 * 1024 * 1024  # 4 MiB, jak w @electron/asar


# ---------------------------------------------------------------- odczyt
def read_archive(path):
    with open(path, 'rb') as f:
        data = f.read()
    # Nagłówek: pickle(uint32 size=4, uint32 header_size) + pickle(string)
    _, header_size, _, json_len = struct.unpack('<4I', data[:16])
    header = json.loads(data[16:16 + json_len].decode('utf-8'))
    base = 8 + header_size
    return data, header, base


def iter_files(node, prefix=''):
    for name, entry in node.get('files', {}).items():
        rel = prefix + name
        if 'files' in entry:
            yield from iter_files(entry, rel + '/')
        else:
            yield rel, entry


def file_bytes(data, base, entry):
    off = base + int(entry['offset'])
    return data[off:off + entry['size']]


def check(entry, blob):
    integ = entry.get('integrity')
    if not integ:
        return None
    return hashlib.sha256(blob).hexdigest() == integ['hash']


# ---------------------------------------------------------------- zapis
def integrity(blob):
    blocks = [hashlib.sha256(blob[i:i + BLOCK_SIZE]).hexdigest()
              for i in range(0, max(len(blob), 1), BLOCK_SIZE)]
    return {
        'algorithm': 'SHA256',
        'hash': hashlib.sha256(blob).hexdigest(),
        'blockSize': BLOCK_SIZE,
        'blocks': blocks,
    }


def build_tree(root, rel_paths):
    tree = {'files': {}}
    for rel in rel_paths:
        node = tree
        parts = rel.split('/')
        for p in parts[:-1]:
            node = node['files'].setdefault(p, {'files': {}})
        node['files'][parts[-1]] = os.path.join(root, *parts)
    return tree


def pack(src_dir, out_path):
    cfg = os.path.join(src_dir, 'neutralino.config.json')
    res = os.path.join(src_dir, 'resources')
    if not os.path.isfile(cfg) or not os.path.isdir(res):
        sys.exit(f'Brak {cfg} lub folderu {res}')

    rel_paths = ['neutralino.config.json']
    for dirpath, dirnames, filenames in os.walk(res):
        dirnames.sort()
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel_paths.append(os.path.relpath(full, src_dir).replace(os.sep, '/'))

    tree = build_tree(src_dir, rel_paths)
    blobs = []
    offset = 0

    def fill(node):
        nonlocal offset
        out = {'files': {}}
        for name in sorted(node['files']):
            val = node['files'][name]
            if isinstance(val, dict):
                out['files'][name] = fill(val)
            else:
                with open(val, 'rb') as f:
                    blob = f.read()
                out['files'][name] = {
                    'size': len(blob),
                    'offset': str(offset),
                    'integrity': integrity(blob),
                }
                blobs.append(blob)
                offset += len(blob)
        return out

    header = fill(tree)
    hjson = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    # pickle string: uint32 len + bajty + wyrównanie do 4
    pad = (4 - len(hjson) % 4) % 4
    header_pickle = struct.pack('<2I', len(hjson) + 4 + pad, len(hjson)) + hjson + b'\0' * pad
    size_pickle = struct.pack('<2I', 4, len(header_pickle))

    with open(out_path, 'wb') as f:
        f.write(size_pickle)
        f.write(header_pickle)
        for b in blobs:
            f.write(b)
    print(f'Zapisano {out_path}: {len(blobs)} plików, {os.path.getsize(out_path)} B')


# ---------------------------------------------------------------- komendy
def cmd_unpack(archive, dest):
    data, header, base = read_archive(archive)
    ok = True
    for rel, entry in iter_files(header):
        blob = file_bytes(data, base, entry)
        good = check(entry, blob)
        ok &= good is not False
        path = os.path.join(dest, *rel.split('/'))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(blob)
        print(f"{'OK ' if good else 'ZŁA SUMA' if good is False else '?  '} {rel} ({len(blob)} B)")
    if not ok:
        sys.exit('Uwaga: niektóre pliki mają niezgodną sumę kontrolną!')


def cmd_verify(archive):
    data, header, base = read_archive(archive)
    bad = 0
    for rel, entry in iter_files(header):
        good = check(entry, file_bytes(data, base, entry))
        bad += good is False
        print(f"{'OK ' if good else 'ZŁA SUMA' if good is False else '?  '} {rel}")
    sys.exit(1 if bad else 0)


def cmd_list(archive):
    _, header, _ = read_archive(archive)
    for rel, entry in iter_files(header):
        print(f"{entry['size']:>10}  {rel}")


def main(argv):
    if len(argv) >= 3 and argv[0] == 'unpack':
        cmd_unpack(argv[1], argv[2])
    elif len(argv) >= 3 and argv[0] == 'pack':
        pack(argv[1], argv[2])
    elif len(argv) >= 2 and argv[0] == 'verify':
        cmd_verify(argv[1])
    elif len(argv) >= 2 and argv[0] == 'list':
        cmd_list(argv[1])
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main(sys.argv[1:])

#!/usr/bin/env python3
"""Generuje pliki testowe dla tests/*.mjs i tests/verify-tags.py.

    pip install --user mutagen imageio-ffmpeg
    python3 tests/make-media.py /home/user/work
"""
import array, math, os, shutil, subprocess, sys, wave

import imageio_ffmpeg
from mutagen.id3 import ID3, TIT2, TPE1, TALB, APIC

W = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '/home/user/work')
os.makedirs(W, exist_ok=True)
FF = imageio_ffmpeg.get_ffmpeg_exe()


def ff(*args):
    subprocess.run([FF, '-loglevel', 'error', '-y', *args], check=True, cwd=W)


def sine_wav(name, idx, dur, sr=44100):
    """Ciągły sinus 440 Hz pocięty na kolejne pliki (idx) — test gapless/crossfade wykrywa przerwy."""
    n = int(sr * dur)
    a = array.array('h')
    for k in range(idx * n, (idx + 1) * n):
        v = int(0.5 * math.sin(2 * math.pi * 440 * k / sr) * 32767)
        a.append(v); a.append(v)
    with wave.open(os.path.join(W, name), 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(a.tobytes())


for i, nm in enumerate(['gA.wav', 'gB.wav', 'gC.wav']):
    sine_wav(nm, i, 4.0)
for i, nm in enumerate(['lA.wav', 'lB.wav', 'lC.wav']):
    sine_wav(nm, i, 10.0)

ff('-f', 'lavfi', '-i', 'testsrc=size=300x300', '-frames:v', '1', 'cover.jpg')
for f in ['t_raw', 't_v23', 't_v24', 't_notag']:
    ff('-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0',
       '-id3v2_version', '0', '-write_id3v1', '0', f + '.mp3')
ff('-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:a', 'aac', '-metadata', 'album=Album M', '-metadata', 'title=Stary', 't.m4a')
ff('-f', 'lavfi', '-i', 'sine=f=440:d=3', '-c:a', 'aac', '-movflags', '+faststart', 't_fast.m4a')
for f in ['t_raw.mp3', 't_notag.mp3']:
    try: ID3(os.path.join(W, f)).delete()
    except Exception: pass
cov = open(os.path.join(W, 'cover.jpg'), 'rb').read()
t = ID3(); t.add(TIT2(encoding=1, text='Stary')); t.add(TPE1(encoding=1, text='Ktoś')); t.add(TALB(encoding=1, text='Album X'))
t.add(APIC(encoding=0, mime='image/jpeg', type=3, desc='', data=cov)); t.save(os.path.join(W, 't_v23.mp3'), v2_version=3)
t = ID3(); t.add(TIT2(encoding=3, text='Stary4')); t.add(TALB(encoding=3, text='Album V4')); t.save(os.path.join(W, 't_v24.mp3'), v2_version=4)

# okładki z sieci: tagi w stylu YouTube (tytuł z wykonawcą i śmieciami, nazwa kanału jako wykonawca)
C = os.path.join(W, 'cov'); shutil.rmtree(C, ignore_errors=True); os.makedirs(C)
COV = [
    ('Imagine Dragons - Bones (Official Audio).mp3', 'Imagine Dragons - Bones (Official Audio)', 'ImagineDragons'),
    ('Believer.mp3', 'Believer', 'Imagine Dragons - Topic'),
    ('Nieznany.mp3', 'Zupełnie Nieznany Kawałek [HD]', 'Ktoś Tam'),
    ('Queen.mp3', 'Bohemian Rhapsody (Remastered 2011)', 'QueenVEVO'),
]
for i, (fn, title, artist) in enumerate(COV):
    ff('-f', 'lavfi', '-i', 'sine=f=%d:d=2' % (350 + i * 50), '-c:a', 'libmp3lame', '-b:a', '96k',
       '-id3v2_version', '0', '-write_id3v1', '0', os.path.join('cov', fn))
    t = ID3(); t.add(TIT2(encoding=1, text=title)); t.add(TPE1(encoding=1, text=artist)); t.save(os.path.join(C, fn), v2_version=3)
print('OK', W)

import sys, subprocess, mutagen, imageio_ffmpeg
W = sys.argv[1]; FF = imageio_ffmpeg.get_ffmpeg_exe(); bad = 0
def dec_ok(p):
    r = subprocess.run([FF, '-v', 'error', '-i', p, '-f', 'null', '-'], capture_output=True, text=True)
    return r.returncode == 0 and not r.stderr.strip(), r.stderr.strip()[:200]
def tags(p):
    f = mutagen.File(p); t = f.tags; d = {}
    if hasattr(t, 'getall'):
        d['title'] = str(t.get('TIT2')); d['artist'] = str(t.get('TPE1')); d['album'] = str(t.get('TALB')); d['cover'] = len(t.getall('APIC'))
        d['ver'] = t.version
    else:
        d['title'] = (t.get('\xa9nam') or [''])[0]; d['artist'] = (t.get('\xa9ART') or [''])[0]; d['album'] = (t.get('\xa9alb') or [''])[0]; d['cover'] = len(t.get('covr') or [])
    d['len'] = round(f.info.length, 2)
    return d
checks = [('out_t_raw.mp3', 'Zażółć gęślą jaźń 🎵', 1, 'None'), ('out_t_v23.mp3', 'Zażółć gęślą jaźń 🎵', 1, 'Album X'), ('out_t_v24.mp3', 'Zażółć gęślą jaźń 🎵', 1, 'Album V4'), ('out_t_notag.mp3', 'Zażółć gęślą jaźń 🎵', 1, 'None'),
          ('out_t.m4a', 'Zażółć gęślą jaźń 🎵', 1, 'Album M'), ('out_t_fast.m4a', 'Zażółć gęślą jaźń 🎵', 1, ''), ('out2_t_v23.mp3', 'Drugi', 0, 'Album X'), ('out2_t.m4a', 'Drugi', 0, 'Album M')]
for f, title, cov, album in checks:
    p = W + '/' + f; d = tags(p); ok, err = dec_ok(p)
    good = (f != 'out_t_raw.mp3' or d.get('ver') == (2, 3, 0)) and d['title'] == title and d['artist'] == 'Łukasz & Ścibor' and d['cover'] == cov and d['album'] == album and ok and abs(d['len'] - 3) < 0.2
    bad += not good
    print('PASS' if good else 'FAIL', f, d, '' if ok else 'DECODE: ' + err)
sys.exit(1 if bad else 0)

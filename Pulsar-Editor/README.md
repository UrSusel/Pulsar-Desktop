# Pulsar Editor 2.0 — audio i napisy (desktop)

Moduł dla wersji **Windows i Linux**, wbudowany w gotowe `resources.neu`. Zachowuje nieniszczący edytor WAV/LRC i dodaje precyzyjną edycję, sesje oraz natywny eksport przez FFmpeg.

## Dla użytkownika

1. Wybierz utwór i kliknij **nożyczki** obok przycisku napisów.
2. W zakładce **Audio**:
   - przeciągnij po fali, aby usunąć fragment; chwyć czerwoną granicę, aby ją przesunąć;
   - użyj **+ / −** albo **Ctrl + kółko**, aby powiększyć falę do 32×; **Pełny utwór** wraca do całości;
   - każdy wycinek ma pola początku i końca z krokiem **1 ms**;
   - **Wykryj ciszę** korzysta z regulowanego progu w dB i minimalnej długości ciszy;
   - **Fade-in**, **fade-out** i **wygładzanie łączeń** ustawia się niezależnie w milisekundach;
   - **Podgląd bez wycinków** pomija zaznaczenia podczas odtwarzania;
   - **Zapisz sesję** zachowuje decyzje edycji. Zmiany zapisują się też automatycznie i wracają po ponownym otwarciu utworu. **Usuń sesję** czyści zapisane decyzje, nie audio.
3. Wybierz **WAV PCM**, **MP3 192 kbps** albo **FLAC** i eksportuj jako nowy utwór. Import wyniku do biblioteki jest opcjonalny.
4. W zakładce **Napisy** reguluj przesunięcie suwakiem, polem liczbowym lub przyciskami ±0,1/±0,5 s. Dodatnia wartość opóźnia tekst, ujemna przyspiesza. **Pierwsze słowo: teraz** wylicza offset z bieżącej pozycji odtwarzania. Jeżeli deklarowana długość źródła lub końcowe znaczniki wyraźnie nie pasują do nagrania, panel pokazuje ostrzeżenie o możliwej innej wersji. **Eksportuj przesunięte .lrc** zapisuje osobny plik.
5. Eksperymentalne **Dopasowanie AI** uruchamiasz ręcznie w tej samej zakładce: wybierz cały utwór albo zakres, język i zaakceptuj jednorazowe pobranie. Wynik najpierw trafia do porównania **źródło / nowe AI**; zapis następuje dopiero po akceptacji, a odrzucenie niczego nie zmienia. **Przywróć napisy źródłowe** usuwa zapisany wynik AI i przywraca zapamiętane źródło także offline.

Edytor nigdy nie zapisuje pod ścieżką oryginału. Metadane, okładka i dopasowane napisy są przenoszone do wpisu biblioteki. Linie z usuniętych zakresów znikają, a pozostałe czasy są przeliczane po cięciach i ręcznym przesunięciu.

Zwykły panel napisów najpierw używa lokalnego LRC i LRCLIB. Jeżeli LRCLIB nie ma czasów słów, resolver odpytuje publiczne **Lyrics+** (`lyricsplus.prjktla.my.id`), które agreguje m.in. Apple Music, QQ Music i Musixmatch. Wynik z prawdziwym `syllabus[]` zastępuje wynik liniowy; słabszy wynik nigdy nie nadpisuje lepszego. Nie jest wymagany token ani osobny tryb karaoke. Publiczna usługa może mieć limity lub przerwy — wtedy zostają dotychczasowe napisy LRCLIB.

Bieżące słowo jest **stopniowo wypełniane białym gradientem bezpośrednio na tekście**, bez ruchomej linii lub paska. Renderer używa rzeczywistego `duration`/`end`, a jeśli go brak — odstępu do następnego słowa albo końca linii. Ostatni wyraz bez `end_ms` jest ograniczony następnym rzeczywistym znacznikiem linii, a w ostatniej linii znanym końcem audio; nie jest mu przypisywany arbitralny czas.

## Eksperymentalne dopasowanie AI (Windows/Linux)

- Funkcja wykonuje **forced alignment dostarczonego tekstu**, a nie transkrypcję: korzysta z linii już znalezionych przez lokalny LRC, LRCLIB lub Lyrics+ i wyznacza czasy słów do lokalnego audio.
- Silnik to przypięte **Stable-TS 2.19.1 + Faster-Whisper 1.2.1**, wielojęzyczny model **base**, CPU/`int8`. Dekodowanie używa PyAV w zgodnym zakresie `av>=12,<19` (PyAV 19 usunął wymagany argument `metadata_errors`), więc systemowy FFmpeg nie jest potrzebny. Kontrola środowiska wykonuje też krótkie dekodowanie PCM, dzięki czemu niezgodna istniejąca instalacja jest naprawiana przy kolejnym uruchomieniu.
- Przed pierwszą instalacją użytkownik zobaczy potwierdzenie i informację o dużym pobraniu. Dopiero wtedy mostek tworzy izolowane `venv`, instaluje pakiety i pozwala pobrać model. Wymagany jest Python **3.10+** (`python3-venv` na dystrybucjach, które wydzielają ten moduł).
- Dane pozostają poza aplikacją i paczkami: `%LOCALAPPDATA%\Pulsar\LyricsAI` na Windows oraz `$XDG_CACHE_HOME/pulsar/lyrics-ai` albo `~/.cache/pulsar/lyrics-ai` na Linuxie. Audio nie jest wysyłane do usługi AI; podczas pierwszego uruchomienia sieć służy do pobrania pakietów/modelu.
- AI nigdy nie uruchamia się automatycznie. Ręczne dopasowanie jest dostępne również przy istniejącym word-sync — przydatne, gdy źródłowe czasy pochodzą z wersji studyjnej, a odtwarzany jest np. teledysk. Zastąpienie źródła wymaga dodatkowego potwierdzenia, a jego kopia pozostaje dostępna do przywrócenia. Brakujące, ujemne, nieuporządkowane lub tekstowo niezgodne czasy nie są „naprawiane” równomiernym rozłożeniem słów; niepełny wynik zostaje odrzucony albo pozostaje zwykłą linią.
- Wynik ma oznaczenie eksperymentalne. Przed zapisem można odsłuchać źródło i nowy wariant na tym samym fragmencie; akceptacja zapisuje go w cache i przy utworze oraz zeruje stary offset, aby nie naliczyć go ponownie. Kopia poprzednich napisów jest zachowana, więc przywrócenie źródła nie wymaga sieci.
- Przy wybranym zakresie helper fizycznie wycina próbki 16 kHz przed `model.align()`, analizuje tylko linie z tego zakresu i po wyniku przywraca czasy do osi całego nagrania. Scalanie zachowuje linie oraz czasy słów poza zakresem; wynik spoza zakresu nie jest przyjmowany, a brakujące czasy nie są zgadywane.
- To eksperyment: śpiew, chóry, instrumenty i przekłady mogą obniżać trafność. Integracja jest testowana z atrapą procesu; rzeczywista jakość modelu na utworach wymaga osobnej walidacji. Funkcja nie jest częścią Androida.

## FFmpeg i duże pliki

- **WAV** dla zwykłych plików nadal działa bez FFmpeg, przez Web Audio i PCM 16-bit.
- **MP3 i FLAC** wymagają `ffmpeg.exe` (Windows) albo `ffmpeg` (Linux) obok aplikacji lub w `PATH`.
- Pliki powyżej **80 MB** lub **30 minut** automatycznie używają natywnej ścieżki FFmpeg. Nie jest tworzony pełny `AudioBuffer`; cięcie i przejścia wykonuje FFmpeg. Fala pochodzi z zapisanej analizy, jeśli jest dostępna, a granice zawsze można ustawić czasem.
- Jeśli źródło ma ścieżkę na dysku, FFmpeg czyta je bezpośrednio. Dla utworu tylko z biblioteki mostek tworzy tymczasową kopię i usuwa ją po eksporcie.
- Przy natywnym wyniku powyżej **256 MB** można zapisać plik, ale import do biblioteki jest pomijany dla ochrony pamięci WebView.

Sesja w `localStorage` zawiera tylko zakresy, ustawienia i zoom — nigdy dane audio.

## Pliki

- `editor-core.js` — cięcia, cisza, WAV, przejścia, argumenty FFmpeg i LRC; bez DOM;
- `lyrics-core.js` — parser zwykłego/rozszerzonego LRC, LRCLIB Lyricsfile oraz Lyrics+ v2 (`Word`/`Syllable`) z rzeczywistymi czasami słów; jest wstawiany inline do wspólnego runtime;
- `lyrics-aligner.py` — osobny helper forced alignmentu z leniwymi importami AI, walidacją żądania i konwerterem wyniku bez sztucznych czasów;
- `audio-editor.js` / `audio-editor.css` — panel, zoom, granice, sesje, podgląd, eksport i ręczny eksperyment AI;
- `tools/runtime_patches.py` — idempotentne zaczepy runtime edytora;
- `tools/build_desktop_editor.py` — wspólny build Windows/Linux dla edytora i `Pulsar-Extras`;
- `tools/test_editor_core.js`, `test_lyrics_core.js`, `test_lyrics_aligner.py`, `test_desktop_editor.py`, `test_editor_browser.mjs` — testy logiki, parserów, konwersji AI, paczek i E2E.

Auto-DJ 2.0, automatyczne kopie i natywny mostek są opisane w [`Pulsar-Extras/README.md`](../Pulsar-Extras/README.md).

## Build i testy

```bash
python Pulsar-Editor/tools/build_desktop_editor.py
python Pulsar-Editor/tools/build_desktop_editor.py --check
node Pulsar-Editor/tools/test_editor_core.js
node Pulsar-Editor/tools/test_lyrics_core.js
python Pulsar-Editor/tools/test_lyrics_aligner.py
node Pulsar-Extras/tools/test_extras.js
node Pulsar-Extras/tools/test_app_updates.js
python Pulsar-Editor/tools/test_desktop_editor.py
python Pulsar-Sync/tools/test_desktop_bundle.py
python Pulsar-Sync/tools/refresh_download_zips.py
```

Test przeglądarkowy wymaga `puppeteer-core` i `@sparticuz/chromium` oraz rozpakowanego `resources.neu`:

```bash
python Pulsar-Sync/tools/neu.py unpack Pulsar-Windows/resources.neu .tmp/editor-test
NODE_PATH=<node_modules> node Pulsar-Editor/tools/test_editor_browser.mjs .tmp/editor-test/resources
EDITOR_DESKTOP=1 NODE_PATH=<node_modules> node Pulsar-Editor/tools/test_editor_browser.mjs .tmp/editor-test/resources
```

E2E używa syntetycznego WAV z ciszą i LRC. Sprawdza cięcia, dokładne granice, zoom, zapis/wznowienie sesji, podgląd, WAV, metadane, napisy po restarcie, stopniowe wypełnianie słowa w zwykłym panelu (kontrola 25/50% i gradientu), fallback liniowy, wybór Lyrics+ po odpowiedzi LRCLIB bez słów, brak osobnej nakładki karaoke, zapis/przywrócenie wyniku AI, kalibrację pierwszego słowa, ostrzeżenie o możliwej innej wersji, porównanie A/B przed zapisem, odrzucenie i scalenie wybranego zakresu, potwierdzone zastąpienie źródłowego word-sync i blokadę bez zgody, Auto-DJ, ręczne sprawdzanie wydań Pulsara (nowszy, aktualny i nienumeryczny tag) oraz — w wariancie desktopowym — pełny przepływ AI przez mostek, naprawę `venv` bez pip i niezgodnego PyAV, natywny zapis, FFmpeg, tryb dużego pliku, rotację `.pulsarlib` i ostrzeżenie przed usunięciem jedynej kopii. Stub FFmpeg testuje integrację i argumenty; nie jest testem zgodności samego kodeka. Analogicznie stub helpera AI sprawdza kontrakt, UI i zapis bez pobierania PyTorch/modelu — nie jest testem trafności alignmentu.

Android pomija desktopowe zasoby edytora i rozszerzeń w `Pulsar-Android/tools/build_web_assets.py`. Wspólny parser i renderer napisów są częścią inline `index.html`, więc czasy słów działają także na telefonie bez kopiowania desktopowych assetów.

# Pulsar Extras — Auto-DJ 2.0, kopie i aktualizacje

Rozszerzenia na licencji Apache-2.0 dla wspólnej paczki desktopowej Windows/Linux. Są dołączane do `resources.neu` przez `Pulsar-Editor/tools/build_desktop_editor.py`; Android usuwa ich znaczniki i zasoby.

## Auto-DJ 2.0

W **Ustawienia → Odtwarzanie → Auto-DJ 2.0** dostępne są:

- nastroje: **Zbalansowany, Spokojnie, Skupienie, Trening, Impreza, Odkrywanie**;
- **Więcej podobnych** — natychmiast wybiera utwór podobny do obecnego i zapisuje przejście w historii DJ;
- osobne suwaki różnorodności **wykonawców** i **gatunków / albumów**; przy 100% powtórka jest omijana, jeśli istnieje alternatywa;
- propozycja następnego utworu z krótkim wyjaśnieniem: nastrój, BPM, tempo, energia, różnorodność lub nowość;
- historia ostatnio wybranych utworów i **Cofnij wybór DJ**, które nie jest mylone z przewijaniem do początku piosenki.

Dobór korzysta z lokalnej analizy BPM/RMS, recency, liczby odtworzeń i ulubionych. Gatunek jest używany, gdy istnieje; w przeciwnym razie kontekstem jest album. Ustawienia są zapisywane w `pulsarAutoDjPlus`. Nie ma wysyłania historii odsłuchu do sieci.

## Automatyczne kopie i bezpieczeństwo

W **Ustawienia → Biblioteka → Automatyczne kopie i bezpieczeństwo**:

- domyślnie włączona kopia `.pulsarlib` **co 7 dni** (opcje: codziennie, co tydzień, co 30 dni);
- domyślnie **3 rotowane wersje**, konfigurowalne od 1 do 10;
- własny folder albo folder domyślny: `Documents/Pulsar/Backups` w profilu Windows, `~/Pulsar/Backups` w Linux;
- przycisk **Utwórz migawkę teraz**;
- niezależny przełącznik migawek przed restore i większymi zmianami.

Harmonogram jest sprawdzany po starcie i co 6 godzin **podczas działania aplikacji**; nie instaluje usługi systemowej. Kopia zawiera utwory, okładki, albumy, ulubione, statystyki i ustawienia, jak ręczny eksport `.pulsarlib`. Dane pozostają lokalnie.

Migawka ochronna powstaje przed:

- przywróceniem innej kopii;
- usunięciem co najmniej 10 utworów albo 25% biblioteki (dla bibliotek od 8 utworów);
- większą deduplikacją;
- usunięciem utworu, którego plik nie ma działającej ścieżki poza biblioteką.

Przy usuwaniu jedynej lokalnej kopii pojawia się osobne ostrzeżenie z nazwami utworów. Jeśli migawka ochronna się nie powiedzie, użytkownik musi świadomie zaakceptować kontynuację. Rotacja sortuje wersje po czasie modyfikacji, a unikalne nazwy zapobiegają nadpisaniu kopii z tej samej sekundy.

## Aktualizacje samego Pulsara

W **Ustawienia → Pobieranie → Pulsar** karta pokazuje zainstalowaną wersję z `app-version.json`. Automatyczne sprawdzanie uruchamia się przy starcie aplikacji, a podczas dłuższej sesji ponawia najwyżej raz na 12 godzin; przycisk **Sprawdź aktualizacje** wykonuje kontrolę na żądanie. Tag `vX.Y.Z` lub `X.Y.Z` jest porównywany jako SemVer. Nowsze wydanie pokazuje komunikat, zwykły tekst informacji o wydaniu oraz przycisk pobrania; jeśli GitHub opublikował pasujący asset Windows/Linux, przycisk prowadzi bezpośrednio do niego, a w przeciwnym razie do strony wydania. Treść release notes jest wyświetlana jako tekst, nie HTML. **Pulsar nie pobiera ani nie instaluje aktualizacji automatycznie**. Stary, nienumeryczny tag jest zgłaszany jako nieznana wersja, a nie jako potwierdzenie aktualności. Automatyczne sprawdzanie można wyłączyć niezależnie od aktualizacji `yt-dlp`.

Endpoint `/releases/latest` wymaga opublikowanego, stabilnego GitHub Release. Sam tag Git albo draft nie wystarczy; kolejne wydania powinny mieć tagi zgodne z SemVer, np. `v0.22.0`.

## Natywny mostek

`desktop-bridge.js` wykrywa FFmpeg obok aplikacji i w `PATH`, udostępnia bezpieczne argumenty procesu, zapis blobów w kawałkach 8 MB, pliki tymczasowe, dialogi oraz operacje potrzebne kopiom. Nie uruchamia usługi HTTP i nie korzysta z zewnętrznego backendu.

Dla ręcznego eksperymentu napisów mostek udostępnia ograniczone `lyricsAiCapabilities()` i `alignLyrics()`. Helper jest kopiowany z zasobów do katalogu użytkownika; ścieżki są cytowane, a żądanie i wynik przechodzą przez tymczasowy JSON. Izolowane `venv` i przypięte pakiety `stable-ts[fw]==2.19.1` / `faster-whisper==1.2.1` oraz zgodny dekoder `av>=12,<19` są instalowane dopiero po potwierdzeniu w UI. Ograniczenie PyAV jest konieczne, ponieważ wersja 19 usunęła `metadata_errors`, którego używa Faster-Whisper 1.2.1; kontrolne dekodowanie PCM wykrywa ten problem także w istniejącym środowisku. Instalator używa `python -m pip`; jeżeli przerwana konfiguracja zostawiła środowisko bez działającego pip, najpierw wykonuje `python -m ensurepip --upgrade`. Model jest pobierany do tego samego katalogu cache, nie do repo ani `resources.neu`. Mostek odrzuca wynik bez rzeczywistych, zgodnych czasów słów. Źródłowy word-sync może zastąpić wyłącznie żądanie z jawnym `allowSourceWordSync`, wystawiane po potwierdzeniu w UI; bez tej zgody mostek i zapis wyniku odrzucają operację.

## Tłumaczenia

`i18n.js` zawiera polskie klucze oraz pełne tłumaczenia **angielskie i hiszpańskie** dla nowych kart, edytora, komunikatów AI, błędów mostka, Auto-DJ i kopii. Runtime rozszerza swoje `t()`/`sweepI18n()` o ten słownik, a zdarzenie `pulsar:lang` odświeża dynamiczne komunikaty bez restartu. Zapisany język EN/ES jest też stosowany ponownie po zakończeniu budowania wszystkich paneli.

## Pliki i testy

- `i18n.js` — wspólny słownik PL/EN/ES i tłumaczenie komunikatów złożonych;
- `dj-core.js`, `auto-dj.js` — czysty selektor oraz UI/historia;
- `backup-core.js`, `library-backup.js` — harmonogram, nazwy, rotacja, UI i strażnicy operacji;
- `desktop-bridge.js` — Neutralino/FFmpeg/system plików;
- `app-updates.js`, `app-version.json` — kontrola GitHub Releases i źródło wersji aplikacji;
- `extras.css` — wspólny wygląd kart;
- `tools/runtime_patches.py` — idempotentne zaczepy wyboru DJ, backupu, usuwania i analizy fali;
- `tools/test_extras.js` — testy nastrojów, podobieństwa, różnorodności, historii, harmonogramu i rotacji;
- `tools/test_app_updates.js` — testy SemVer, odpowiedzi GitHub, błędów i harmonogramu aktualizacji;
- `tools/test_i18n.js` — kompletność słownika, komunikaty złożone i zgodność wszystkich odwołań `tr()`.

```bash
node Pulsar-Extras/tools/test_extras.js
node Pulsar-Extras/tools/test_app_updates.js
node Pulsar-Extras/tools/test_i18n.js
python Pulsar-Editor/tools/build_desktop_editor.py --check
python Pulsar-Editor/tools/test_desktop_editor.py
```

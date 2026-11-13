#!/usr/bin/env python3
"""Regression checks for the expanded tour and retro background controls."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def check(platform: str) -> None:
    source = (ROOT / "Pulsar-Core" / platform / "resources" / "index.html").read_text(encoding="utf-8")
    required_tour = {
        "Cięcie i edycja audio": "Kliknij nożyczki obok przycisku tekstów",
        "Napisy i dopasowanie AI": "przywrócić źródłowe napisy",
        "Muzyka polecana dla Ciebie": "W Bibliotece otwórz zakładkę",
    }
    album_copy = "Twórz albumy, zmieniaj kolejność i okładki, odtwarzaj w kolejności lub losowo. Zaznacz utwory na liście i dodaj je do własnego albumu; po otwarciu albumu możesz wygenerować własny plakat z jego okładek."
    assert f"'{album_copy}': {{ en:" in source, f"{platform}: album poster help is not translated"
    for title, copy in required_tour.items():
        assert f"title:'{title}'" in source and copy in source, f"{platform}: missing onboarding step {title}"
        assert f"'{title}': {{ en:" in source, f"{platform}: missing EN/ES title translations for {title}"
    assert "id=\"retroBgBtn\"" in source, f"{platform}: retro background control missing"
    assert "function setRetroBackground(background)" in source, f"{platform}: background switch handler missing"
    assert "localStorage.setItem('playerRetroBackground', chosen.id)" in source, f"{platform}: background choice is not saved"
    for name, background in (("Tło okładki", "cover"), ("Mgławica retro", "nebula"),
                             ("Siatka retro", "grid"), ("Zorza retro", "aurora")):
        assert f"'{name}': {{ en:" in source, f"{platform}: missing translations for {name}"
        if background != "cover":
            assert f'data-retro-background="{background}"' in source, f"{platform}: missing {background} styling"
    assert "body.retro-mode.fullscreen-mode .player { position:relative;" in source
    assert "min-height:100vh; max-height:none;" in source
    assert "body.retro-mode.fullscreen-mode .cover-display-stack" in source
    print(f"{platform}: onboarding/background/fullscreen checks passed")


if __name__ == "__main__":
    for target in ("Linux", "Windows"):
        check(target)

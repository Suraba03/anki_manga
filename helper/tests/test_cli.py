from anki_manga_helper import config as cfg
from anki_manga_helper.cli import main


def test_reset_pairing(capsys):
    c = cfg.load_config()
    c.paired = True
    cfg.save_config(c)
    old = c.token
    assert main(["--reset-pairing"]) == 0
    after = cfg.load_config()
    assert after.paired is False
    assert after.token != old
    assert "Pairing reset" in capsys.readouterr().out

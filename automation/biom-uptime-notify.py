#!/usr/bin/env python3
"""Оповещения и инциденты для биомрегиона.рф (плагин Uptime).

- Читает `bb uptime list --json`.
- Состояние хранит в biomregiona-uptime-state.json (в рабочем каталоге).
- Смена статуса -> пуш-уведомление.
- Переход в DOWN (подтверждён 2 неудачными чеками) -> заодно запускает
  инцидент-агента: дочерний тред мониторингового треда, который диагностирует
  причину и отчитывается отцу (мониторинговый тред).
- Без изменений состояние -> тихий выход 0 (silent tick).
"""
import json
import os
import subprocess
import sys
import time

STATE_FILE = "biomregiona-uptime-state.json"
PROJECT_ID = os.environ.get("PROJECT_ID", "")
MONITOR_THREAD = os.environ.get("MONITOR_THREAD", "")

INCIDENT_PROMPT = """Сайт недоступен: плагин Uptime подтвердил падение (2 неудачных health-чека подряд).

Текущее состояние из `bb uptime list --json`:
{status_lines}

Известные факты:
- Оба сайта указывают на VPS 161.104.50.72: продакшен https://xn--80abghoczlees.xn--p1ai/ и dev https://xn--b1add.xn--80abghoczlees.xn--p1ai/.
- Деплой идёт через GitLab CI: gitlab.com/ml.devs/botanic-portal/eko-labs; репозиторий на этом хосте в /home/autowork/botanic-portal.
- SSH-доступа к VPS с этой машины нет (ключи — секреты GitLab CI), подключаться к VPS не пытайтесь.

Задача — диагностировать причину (только чтение, ничего не менять):
1. DNS: резолвится ли домен (curl "https://dns.google/resolve?name=<домен>&type=A"); сравните с другими .рф/.ру сайтами и известным .com — проблема у локального резолвера или глобальная.
2. HTTPS: curl -svv https://<домен>/health — статус-код, срок действия TLS-сертификата, время ответа.
3. Вывод по типу сбоя: DNS / TLS / 5xx / таймаут / другое.
4. Был ли свежий деплой перед сбоем: git log --oneline -5 --date=iso в /home/autowork/botanic-portal (только чтение).

Результат (на русском):
- Короткий вывод в Telegram команды: `bb telegram-relay broadcast --title "<≤80 символов>" --body "<≤180 символов>" --channels incidents --level critical`.
- Итоговый ответ родителю: подробный отчёт — что лежит, доказательства (команды и выводы), вероятная причина, что делать человеку.
"""


def bb(*args, input_text=None):
    return subprocess.run(
        ["bb", *args], input=input_text, capture_output=True, text=True, timeout=120
    )


def notify(title, body, channels, level):
    r = bb("telegram-relay", "broadcast", "--title", title[:80], "--body", body[:180],
           "--channels", channels, "--level", level)
    if r.returncode != 0:
        sys.stderr.write("broadcast failed: %s %s\n" % (r.stdout.strip(), r.stderr.strip()))
        return False
    return True


def spawn_incident_agent(status_lines):
    """Запустить дочерний тред-диагност. Вернуть True при успехе."""
    if not PROJECT_ID or not MONITOR_THREAD:
        sys.stderr.write("PROJECT_ID/MONITOR_THREAD not set, skip incident agent")
        return False
    args = ["thread", "spawn", "--project", PROJECT_ID,
            "--parent-thread", MONITOR_THREAD, "--prompt-file", "-"]
    r = bb(*args, input_text=INCIDENT_PROMPT.format(status_lines=status_lines))
    if r.returncode != 0:
        sys.stderr.write("thread spawn failed: %s %s\n" % (r.stdout.strip(), r.stderr.strip()))
        return False
    return True


def label_of(site):
    name = site.get("name") or site.get("url") or "?"
    return name.split(" (")[0]


def site_status(checks, old):
    """(статус, деталь). UP при ok последнего чека; DOWN — только при двух
    подряд неудачных (или если статус уже был DOWN)."""
    if not checks:
        return (old or "DOWN"), "нет данных о проверках"
    last = checks[-1]
    if last.get("ok"):
        return "UP", "%s %sms" % (last.get("status"), last.get("ms"))
    detail = (last.get("error") or "HTTP %s" % last.get("status") or "ошибка")[:60]
    if len(checks) >= 2 and checks[-2].get("ok") and old == "UP":
        return "UP", "один неудачный чек: %s (жду подтверждения)" % detail
    return "DOWN", detail


def main():
    r = bb("uptime", "list", "--json")
    if r.returncode != 0:
        sys.stderr.write("bb uptime list failed: %s\n" % (r.stderr or r.stdout).strip())
        return 1
    sites = json.loads(r.stdout)
    if not sites:
        sys.stderr.write("no sites in uptime plugin")
        return 1

    state_path = os.path.join(os.getcwd(), STATE_FILE)
    had_state = os.path.exists(state_path)
    old = {}
    if had_state:
        try:
            with open(state_path, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            old = {}

    new = {}
    lines = []
    all_up = True
    for site in sites:
        st, detail = site_status(site.get("checks") or [], old.get(site["id"]))
        new[site["id"]] = st
        if st != "UP":
            all_up = False
        lines.append(("%s: %s — %s" % (label_of(site), st, detail))[:80])

    now = time.strftime("%d.%m %H:%M")
    body = "\n".join(lines[:6]) + "\n" + now
    save_state = lambda: json.dump(new, open(state_path, "w", encoding="utf-8"))

    if not had_state:
        # Первый запуск: подтвердить включение мониторинга
        ok = notify("📡 Мониторинг биомрегиона.рф включён",
                    ("Всё работает. " if all_up else "Внимание: не всё работает. ") + body,
                    "monitoring,incidents", "info" if all_up else "critical")
        if ok:
            save_state()
        return 0 if ok else 1

    old_known = {k: v for k, v in old.items() if k in new}
    if old_known == new:
        # Состояние не изменилось — тихий такт
        return 0

    # Смена статуса: пуш + (только при переходе в DOWN) инцидент-агент
    went_down = any(s == "DOWN" for s in new.values())
    title = "✅ биомрегиона.рф: всё работает" if all_up else "⚠️ биомрегиона.рф: есть проблемы"
    ok = notify(title, body, "monitoring,incidents", "critical" if not all_up else "info")
    if ok and went_down:
        ok = spawn_incident_agent("\n".join(lines))
    if ok:
        save_state()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

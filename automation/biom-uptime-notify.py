#!/usr/bin/env python3
"""Оповещения и инциденты для биомрегиона.рф (плагин Uptime).

- Читает `bb uptime list --json`.
- Состояние хранит в biomregiona-uptime-state.json (в рабочем каталоге):
  UP-сайт — строка "UP"; DOWN-сайт — объект-«окно» DOWN:
  {"status": "DOWN", "alert_sent_at": <unix-сек последней успешно
  доставленной алерта, null пока не доставлен>, "agent_spawned": <bool>}.
- Смена статуса -> пуш-уведомление.
- Переход в DOWN (подтверждён 2 неудачными чеками) -> заодно запускает
  инцидент-агента: дочерний тред мониторингового треда, который диагностирует
  причину и отчитывается отцу (мониторинговый тред).
- Один алерт на DOWN-окно: окно пишется в state-файл ДО broadcast (если ран
  убит таймаутом автотаска, следующее тик-прогон увидит окно, а не «свежую
  смену статуса» — дублей не будет). Если уже DOWN и последняя успешная
  алерт-доставка свежее ALERT_DEDUPE_SECS — повторный алерт не шлём (лог в
  stderr). Окно с недоставленным/устаревшим алертом догоняется на
  следующем тике.
- Неблокирующий flock на lock-файле рядом с state-файлом не даёт ранам
  пересекаться (процесс, убитый таймаутом автотаска, отпускает flock при
  смерти; занятый лок -> тихий exit 0).
- Неудавшийся DOWN-алерт повторяем один раз с бэкоффом. Бюджет (таймаут
  автотаска = 90 с): одна попытка broadcast ≤ 3 чата × 10 с (per-chat
  client-timeout в relay) + pacing ≈ 32 с; 1 + 1 повтор = 32 + 5 + 32 ≈ 69 с
  < 90 с. Поэтому повтор ровно один.
- Без изменений состояние (и всё доставлено) -> тихий выход 0 (silent tick).
"""
import fcntl
import json
import os
import subprocess
import sys
import time

STATE_FILE = "biomregiona-uptime-state.json"
LOCK_FILE = "biomregiona-uptime-state.json.lock"
# Один алерт на DOWN-окно: не повторять, пока последняя успешная доставка
# алерта свежее этого порога (старее — повтор, т.к. сбой не снят).
ALERT_DEDUPE_SECS = 15 * 60
# Бэкофф повтора неудавшегося DOWN-алерта. Одна попытка ≈ 32 с (см. бюджет
# в docstring), поэтому при 90-секундном таймауте автотаска допустим ровно
# один повтор: 32 + 5 + 32 ≈ 69 с < 90 с. В тестах сокращается env.
RETRY_BACKOFF_SECS = int(os.environ.get("BIOM_RETRY_BACKOFF_SECS", "5"))

PROJECT_ID = os.environ.get("PROJECT_ID", "")
MONITOR_THREAD = os.environ.get("MONITOR_THREAD", "")
INCIDENT_PROVIDER = os.environ.get("INCIDENT_PROVIDER", "")
INCIDENT_MODEL = os.environ.get("INCIDENT_MODEL", "")
INCIDENT_REASONING = os.environ.get("INCIDENT_REASONING", "")

INCIDENT_PROMPT = """Сайт недоступен: плагин Uptime подтвердил падение (2 неудачных health-чека подряд).

Текущее состояние из `bb uptime list --json`:
{status_lines}

Известные факты:
- Оба сайта работают на одном VPS (адрес и окружение — в ваших деплой-доках).
- Деплой идёт через ваш GitLab CI; локальный checkout репозитория: <your-repo-checkout>.
- SSH-доступа к VPS с этой машины нет (ключи — секреты GitLab CI), подключаться к VPS не пытайтесь.

Задача — диагностировать причину (только чтение, ничего не менять):
1. DNS: резолвится ли домен (curl "https://dns.google/resolve?name=<домен>&type=A"); сравните с другими .рф/.ру сайтами и известным .com — проблема у локального резолвера или глобальная.
2. HTTPS: curl -svv https://<домен>/health — статус-код, срок действия TLS-сертификата, время ответа.
3. Вывод по типу сбоя: DNS / TLS / 5xx / таймаут / другое.
4. Был ли свежий деплой перед сбоем: git log --oneline -5 --date=iso в локальном checkout (<your-repo-checkout>), только чтение.

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


def notify_with_retry(title, body, channels, level):
    """Broadcast с одним повтором после бэкофф (бюджет — в docstring)."""
    ok = notify(title, body, channels, level)
    if ok:
        return True
    sys.stderr.write("broadcast failed, retry in %ds\n" % RETRY_BACKOFF_SECS)
    time.sleep(RETRY_BACKOFF_SECS)
    return notify(title, body, channels, level)


def spawn_incident_agent(status_lines):
    """Запустить дочерний тред-диагност. Вернуть True при успехе."""
    if not PROJECT_ID or not MONITOR_THREAD:
        sys.stderr.write("PROJECT_ID/MONITOR_THREAD not set, skip incident agent")
        return False
    args = ["thread", "spawn", "--project", PROJECT_ID,
            "--parent-thread", MONITOR_THREAD, "--prompt-file", "-"]
    if INCIDENT_PROVIDER:
        args += ["--provider", INCIDENT_PROVIDER]
    if INCIDENT_MODEL:
        args += ["--model", INCIDENT_MODEL]
    if INCIDENT_REASONING:
        args += ["--reasoning-level", INCIDENT_REASONING]
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


def state_status(v):
    """Статус сайта из state-значения (совместимо со старым форматом)."""
    return v.get("status") if isinstance(v, dict) else v


def state_field(v, field, default=None):
    return v.get(field, default) if isinstance(v, dict) else default


def down_window(alert_sent_at=None, agent_spawned=False):
    return {"status": "DOWN", "alert_sent_at": alert_sent_at, "agent_spawned": agent_spawned}


def acquire_lock(path):
    """Неблокирующий эксклюзивный flock. None, если лок занят другим раном.

    fd живёт до смерти процесса: ядро отпускает flock при любом выходе
    (включая SIGKILL таймаута автотаска), так что «зависший» ран не
    блокирует мониторинг навсегда.
    """
    fd = os.open(path, os.O_CREAT | os.O_RDWR)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def main():
    work = os.getcwd()
    lock_fd = acquire_lock(os.path.join(work, LOCK_FILE))
    if lock_fd is None:
        # Другой ран уже в полёте (например, медленно добирается broadcast
        # предыдущего тика). Тихий exit 0: следующее тик-прогон повторит.
        return 0

    r = bb("uptime", "list", "--json")
    if r.returncode != 0:
        sys.stderr.write("bb uptime list failed: %s\n" % (r.stderr or r.stdout).strip())
        return 1
    sites = json.loads(r.stdout)
    if not sites:
        sys.stderr.write("no sites in uptime plugin")
        return 1

    state_path = os.path.join(work, STATE_FILE)
    had_state = os.path.exists(state_path)
    old = {}
    if had_state:
        try:
            with open(state_path, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            old = {}

    new_status = {}
    lines = []
    all_up = True
    for site in sites:
        st, detail = site_status(site.get("checks") or [], state_status(old.get(site["id"])))
        new_status[site["id"]] = st
        if st != "UP":
            all_up = False
        lines.append(("%s: %s — %s" % (label_of(site), st, detail))[:80])

    now = int(time.time())
    body = "\n".join(lines[:6]) + "\n" + time.strftime("%d.%m %H:%M")

    def build_state():
        # DOWN-сайт — либо новое окно (alert_sent_at=None, agent_spawned=False),
        # либо продолжение существующего (маркеры окна сохраняем).
        out = {}
        for site_id, st in new_status.items():
            prev = old.get(site_id)
            if st == "DOWN":
                if state_status(prev) == "DOWN":
                    out[site_id] = down_window(
                        state_field(prev, "alert_sent_at"),
                        state_field(prev, "agent_spawned", False),
                    )
                else:
                    out[site_id] = down_window()
            else:
                out[site_id] = "UP"
        return out

    def save_state(st):
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(st, f)

    def finish_down_windows(st):
        """Доставить алерт DOWN-окон (дедуп: не чаще раза в ALERT_DEDUPE_SECS)
        и запустить инцидент-агента для окон, где он ещё не запущен.

        Состояние пишется ДО broadcast: если ран убьют таймаутом, окно уже
        персистировано — следующий тик не увидит «свежую смену статуса».
        """
        windows = [v for v in st.values() if isinstance(v, dict)]
        need_broadcast = any(
            v["alert_sent_at"] is None or now - v["alert_sent_at"] >= ALERT_DEDUPE_SECS
            for v in windows
        )
        need_agent = any(not v["agent_spawned"] for v in windows)
        if not need_broadcast and not need_agent:
            for v in windows:
                sys.stderr.write(
                    "already DOWN, alert delivered %ds ago (< %d s): "
                    "skipping repeated alert\n" % (now - v["alert_sent_at"], ALERT_DEDUPE_SECS))
            return True
        if need_broadcast:
            save_state(st)
            if not notify_with_retry("⚠️ биомрегиона.рф: есть проблемы", body,
                                      "monitoring,incidents", "critical"):
                # Окно персистировано без alert_sent_at — следующий тик
                # доставит алерт (кросс-тик повтор).
                return False
            for v in windows:
                v["alert_sent_at"] = now
            save_state(st)
        if need_agent:
            if spawn_incident_agent("\n".join(lines)):
                for v in windows:
                    v["agent_spawned"] = True
                save_state(st)
            else:
                sys.stderr.write(
                    "incident agent spawn failed (alert delivered); "
                    "will retry the agent on the next tick\n")
        return True

    if not had_state:
        # Первый запуск: подтвердить включение мониторинга
        ok = notify("📡 Мониторинг биомрегиона.рф включён",
                    ("Всё работает. " if all_up else "Внимание: не всё работает. ") + body,
                    "monitoring,incidents", "info" if all_up else "critical")
        if ok:
            st = build_state()
            # «Включён»-broadcast подтверждает алерт открытых DOWN-окон.
            for v in st.values():
                if isinstance(v, dict):
                    v["alert_sent_at"] = now
            save_state(st)
        return 0 if ok else 1

    old_known = {k: state_status(v) for k, v in old.items() if k in new_status}
    if old_known == new_status:
        # Состояние не изменилось — тихий такт; исключение — DOWN-окна, у
        # которых алерт (или инцидент-агент) ещё не доставлен. Если повтор
        # алерта не удался — rc 1 (окно персистировано, следующий тик
        # повторит; в логе автотаска виден неснятый сбой).
        st = build_state()
        windows = [v for v in st.values() if isinstance(v, dict)]
        if not windows:
            return 0
        return 0 if finish_down_windows(st) else 1

    # Смена статуса
    st = build_state()
    if all_up:
        # ✅-восстановление: первый UP после DOWN, потом окна чистятся
        ok = notify("✅ биомрегиона.рф: всё работает", body, "monitoring,incidents", "info")
        if ok:
            save_state(st)
        return 0 if ok else 1
    return 0 if finish_down_windows(st) else 1


if __name__ == "__main__":
    sys.exit(main())

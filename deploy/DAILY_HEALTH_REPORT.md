# Ежедневная сводка о сервере в Telegram

Раз в сутки в 10:00 MSK админу (`ADMIN_TELEGRAM_ID`) приходит короткий отчёт:
сервисы, API, WARP, ошибки бота, база, диск, память, нагрузка. Строки с
проблемами помечены 🔴, и только такой отчёт приходит со звуком — обычный
уходит тихим уведомлением.

## Где что

| файл | роль |
|---|---|
| `deploy/daily_health_report.py` | сам отчёт; запускается **на хосте**, не в контейнере |
| `deploy/daily-health-report.service` | разовый запуск |
| `deploy/daily-health-report.timer` | расписание, 10:00 MSK, с досылкой после простоя |

Скрипт живёт на хосте, потому что половина отчёта — диск, память и статусы
контейнеров, которых изнутри контейнера не видно. Пробрасывать `docker.sock`
внутрь ради этого нельзя: доступ к нему равносилен root на хосте.

Отправка идёт `curl`'ом через тот же SOCKS-прокси WARP, что и у бота — напрямую
Telegram с этого VPS недоступен.

## Установка на новом сервере

Деплой кладёт только `deploy/daily_health_report.py` (он внутри рабочего
дерева). Юниты systemd лежат вне дерева, поэтому ставятся руками один раз:

```bash
scp deploy/daily-health-report.service deploy/daily-health-report.timer iseller:/etc/systemd/system/
ssh iseller "systemctl daemon-reload && systemctl enable --now daily-health-report.timer"
```

## Проверить руками

```bash
ssh iseller "python3 /opt/techshop/deploy/daily_health_report.py"
```

Расписание и последний запуск:

```bash
ssh iseller "systemctl list-timers daily-health-report.timer --no-pager; journalctl -u daily-health-report --no-pager -n 20"
```

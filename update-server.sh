#!/usr/bin/env bash
# Обновление сервера в одну команду (с деплой-страховкой, v4 pre-launch).
# Запуск из Git Bash в папке проекта:  bash update-server.sh
#
# Что делает:
#   1) pg_dump боевой БД -> /opt/backups/techshop_YYYY-mm-dd_HHMM.sql.gz на сервере;
#   2) tar-синхронизация кода (серверный .env НЕ трогается);
#   3) пересборка и перезапуск стека;
#   4) health check /api/health — если он не прошёл, скрипт завершается ошибкой
#      (код и контейнеры уже обновлены; откат = git checkout + повторный запуск,
#       данные целы — бэкап из шага 1).
set -euo pipefail

# --- Гарантируем запуск под Git Bash, а не под WSL -------------------------
# Деплой ходит на сервер по SSH-алиасу `iseller` из Windows-конфига
# C:\Users\<you>\.ssh\config (его читает именно Git Bash). У WSL свой отдельный
# ~/.ssh без этого алиаса -> "ssh: Could not resolve hostname iseller". При этом
# `bash` в Windows PATH указывает на лаунчер WSL, поэтому `bash update-server.sh`
# из PowerShell/cmd уходит в WSL. Если это произошло — тихо перезапускаем скрипт
# через Git Bash. В самом Git Bash проверка ниже всегда ложна, поведение прежнее.
_iseller_is_wsl() {
  [ -n "${WSL_DISTRO_NAME:-}" ] && return 0
  case "$(uname -r 2>/dev/null | tr '[:upper:]' '[:lower:]')" in
    *microsoft*|*wsl*) return 0 ;;
  esac
  if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then return 0; fi
  return 1
}
if [ "${1:-}" != "--reexec-gitbash" ] && _iseller_is_wsl; then
  _self_dir_win="$(wslpath -m "$(cd "$(dirname "$0")" && pwd)" 2>/dev/null || true)"
  _self_base="$(basename "$0")"
  for _gb in \
    "/mnt/c/Program Files/Git/bin/bash.exe" \
    "/mnt/c/Program Files (x86)/Git/bin/bash.exe" \
    "/mnt/c/Program Files/Git/usr/bin/bash.exe" \
    "${HOME}/AppData/Local/Programs/Git/bin/bash.exe"; do
    if [ -x "$_gb" ]; then
      echo ">> Обнаружен WSL — деплою нужен Git Bash (Windows ~/.ssh/config)." >&2
      echo ">> Перезапускаю через Git Bash: $_gb" >&2
      exec "$_gb" -lc 'cd "$1" && exec bash "$2" --reexec-gitbash' _ "$_self_dir_win" "$_self_base"
    fi
  done
  echo "!! Скрипт запущен под WSL, а Git Bash не найден автоматически." >&2
  echo "!! Откройте «Git Bash» и выполните:" >&2
  echo "!!     cd /c/iseller-demo && bash update-server.sh" >&2
  exit 1
fi
# Если пришли из ветки перезапуска — убираем служебный аргумент.
[ "${1:-}" = "--reexec-gitbash" ] && shift || true
# ---------------------------------------------------------------------------

SERVER="iseller"                 # алиас из ~/.ssh/config -> root@158.255.1.248
REMOTE_DIR="/opt/techshop"
BACKUP_DIR="/opt/backups"
# backend порт наружу не пробрасывает (см. docker-compose.prod.yml) — проверяем
# изнутри docker-сети через `compose exec`, а не localhost:8000 на хосте.
HEALTH_CMD="docker compose -f docker-compose.prod.yml exec -T backend python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=3)\""

echo ">> 1/4 бэкап боевой БД (pg_dump -> $BACKUP_DIR)"
ssh "$SERVER" "set -e; mkdir -p $BACKUP_DIR; cd $REMOTE_DIR && \
  docker compose -f docker-compose.prod.yml exec -T db sh -c 'pg_dump -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"' \
  | gzip > $BACKUP_DIR/techshop_\$(date +%F_%H%M).sql.gz && \
  ls -lh $BACKUP_DIR | tail -3"

echo ">> 2/4 синхронизирую код на сервер ($SERVER:$REMOTE_DIR)"
tar czf - \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=.env \
  --exclude=.git \
  --exclude=caddy_data \
  --exclude=caddy_config \
  --exclude=update-server.sh \
  --exclude=.claude \
  --exclude=.worktrees \
  --exclude=artifacts \
  --exclude=docs/handoff \
  --exclude=release-evidence \
  . | ssh "$SERVER" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR"

echo ">> 3/4 пересобираю и перезапускаю стек"
ssh "$SERVER" "set -e; cd $REMOTE_DIR; docker compose -f docker-compose.prod.yml up -d --build; docker image prune -f >/dev/null 2>&1 || true"

echo ">> 4/4 health check (внутри docker-сети, до 60 секунд)"
if ssh "$SERVER" "cd $REMOTE_DIR && for i in \$(seq 1 12); do $HEALTH_CMD >/dev/null 2>&1 && exit 0; sleep 5; done; exit 1"; then
  echo ">> health OK"
else
  echo "!! HEALTH CHECK FAILED — backend не отвечает на /api/health изнутри контейнера"
  echo "!! Смотрите логи: ssh $SERVER 'cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml logs backend --tail 50'"
  ssh "$SERVER" "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'" || true
  exit 1
fi

echo ">> статус контейнеров:"
ssh "$SERVER" "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'"

echo ">> готово. Бот и админка обновлены, бэкап БД лежит в $BACKUP_DIR."

#!/usr/bin/env bash
# Токен читателя: создаёт новый, кладёт на прод (.env) и на fi (.env читателя).
# Токен нигде не печатается. Убирает и строку-опечатку nPRICE_READER_TOKEN, если она есть.
# Запуск (PowerShell, из C:\iseller-demo\.worktrees\price-admin):
#   & "C:\Program Files\Git\bin\bash.exe" tools/tg_reader/setup_token.sh
set -euo pipefail

TOKEN="$(openssl rand -hex 32)"

echo "1/3 прод: пишу токен в /opt/techshop/.env"
ssh iseller "cd /opt/techshop \
  && sed -i '/^nPRICE_READER_TOKEN=/d;/^PRICE_READER_TOKEN=/d' .env \
  && printf '\nPRICE_READER_TOKEN=%s\n' '$TOKEN' >> .env"

echo "2/3 fi: пишу токен в /opt/iseller-reader/.env"
ssh fi "cd /opt/iseller-reader \
  && sed -i '/^READER_TOKEN=/d' .env \
  && printf 'READER_TOKEN=%s\n' '$TOKEN' >> .env \
  && chmod 600 .env"

echo "3/3 проверка (значения не показываю):"
ssh iseller "grep -c '^PRICE_READER_TOKEN=.\{64\}\$' /opt/techshop/.env | sed 's/^/  прод, строк с токеном: /'; \
             grep -c '^nPRICE' /opt/techshop/.env | sed 's/^/  прод, строк-опечаток: /' || true"
ssh fi "grep -c '^READER_TOKEN=.\{64\}\$' /opt/iseller-reader/.env | sed 's/^/  fi, строк с токеном: /'"
echo "Готово. Ожидаемо: прод 1, опечаток 0, fi 1."

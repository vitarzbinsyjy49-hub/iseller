# Свидетельства приёмки RC2

Всё в этой папке получено на **локальной production-сборке**: витрина и админка
собраны `Dockerfile.prod` (nginx + статика Vite) — тот же образ, что уезжает на
сервер, а не dev-сервер Vite.

| файл | что это |
|---|---|
| `report.json` | машинный отчёт прогона: 113 проверок, шаги, матрица UI, идентификаторы тестовых сущностей |
| `screenshots/` | 14 скриншотов (headless Chromium, масштаб 2×) |
| `e2e.mjs` | сам прогон — воспроизводимый, без единого пароля |
| `nginx-e2e.conf` | конфиг nginx для локального стенда (в прод-образ не попадает) |
| `rollback.sql` | откат схемы релиза одним файлом |

## Как воспроизвести

```bash
# 1. Собрать production-образы и поднять их рядом с работающим backend
docker build -f frontend/Dockerfile.prod -t iseller-rc2-frontend:local frontend
docker build -f admin/Dockerfile.prod    -t iseller-rc2-admin:local    admin
docker run -d --name rc2-frontend --network iseller-demo_default -p 4180:80 \
  -v "$PWD/release-evidence/nginx-e2e.conf":/etc/nginx/conf.d/default.conf:ro \
  iseller-rc2-frontend:local
docker run -d --name rc2-admin --network iseller-demo_default -p 4181:80 \
  -v "$PWD/release-evidence/nginx-e2e.conf":/etc/nginx/conf.d/default.conf:ro \
  iseller-rc2-admin:local

# 2. Прогон (нужен puppeteer-core и системный Chrome)
npm i puppeteer-core
node release-evidence/e2e.mjs ./release-evidence
```

Прогон требует `DEV_MODE=true` у backend: вход покупателя идёт через
существующий `/auth/dev`, вход администратора — через `/auth/admin/dev`.
Ни один пароль в скрипте не участвует.

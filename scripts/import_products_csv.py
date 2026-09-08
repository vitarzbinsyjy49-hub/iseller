#!/usr/bin/env python3
"""Импорт товаров из CSV/XLSX/JSON через batch-эндпоинты Import Center — без SSH.

Тот же путь, что и загрузка файла в админке («Импорт»): preview создаёт job со
staged-файлом, confirm применяет его по job_id. Поэтому импорт виден в админке
как обычная задача, а не как невидимая правка БД из inline-питона по ssh.

Правило `preview -> apply`, как и везде в проекте: без --confirm база не
меняется, печатается только отчёт (создать/обновить/без изменений/ошибки).

Требует ADMIN_EMAIL/ADMIN_PASSWORD — из окружения или из .env (по умолчанию .env
в корне репозитория). Локальный .env и боевой /opt/techshop/.env не совпадают
автоматически: при 401 сверяться с тем, какой пароль реально стоит на сервере.

Примеры:

    # сухой прогон на проде
    python scripts/import_products_csv.py \\
        --base-url https://158.255.1.248.sslip.io \\
        --file backend/app/scripts/data/apostle_2026_09_07.csv

    # применить
    python scripts/import_products_csv.py --base-url ... --file ... --confirm
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _admin_credentials(env_file: Path) -> tuple[str, str]:
    email = os.environ.get("ADMIN_EMAIL")
    password = os.environ.get("ADMIN_PASSWORD")
    if email and password:
        return email, password
    values = _load_env_file(env_file)
    email = email or values.get("ADMIN_EMAIL")
    password = password or values.get("ADMIN_PASSWORD")
    if not email or not password:
        print(f"ADMIN_EMAIL/ADMIN_PASSWORD не найдены ни в окружении, ни в {env_file}",
              file=sys.stderr)
        sys.exit(2)
    return email, password


def _fail(resp: httpx.Response, what: str) -> None:
    print(f"{what} не удалось ({resp.status_code}): {resp.text[:2000]}", file=sys.stderr)
    sys.exit(1)


def login(client: httpx.Client, base_url: str, email: str, password: str) -> str:
    resp = client.post(f"{base_url}/api/auth/admin/login",
                       json={"email": email, "password": password})
    if resp.status_code != 200:
        _fail(resp, "Вход админа")
    return resp.json()["access_token"]


def print_report(report: dict, *, show_rows: int) -> None:
    s = report.get("summary", {})
    print("— сводка —")
    for key, label in (("rows_total", "строк в файле"), ("create", "создать"),
                       ("update", "обновить"), ("unchanged", "без изменений"),
                       ("skip", "пропустить"), ("errors", "ошибок"),
                       ("warnings", "с предупреждениями"),
                       ("duplicates", "дублей SKU"),
                       ("products_without_photos", "товаров без фото")):
        if key in s:
            print(f"  {label:24} {s[key]}")

    for row in report.get("rows", []):
        if row.get("errors"):
            print(f"  !! строка {row.get('source_line')} [{row.get('sku')}]: "
                  f"{'; '.join(row['errors'])}")
    for row in report.get("rows", []):
        if row.get("warnings"):
            print(f"  ~  строка {row.get('source_line')} [{row.get('sku')}]: "
                  f"{'; '.join(row['warnings'])}")

    if show_rows:
        print("— строки —")
        for row in report.get("rows", [])[:show_rows]:
            ch = row.get("changes") or {}
            title = ch.get("title", "")
            price = ch.get("price", "")
            print(f"  {row.get('action'):9} {row.get('sku'):34} {price:>9} {title}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="https://158.255.1.248.sslip.io",
                        help="Адрес API (по умолчанию прод)")
    parser.add_argument("--file", required=True, action="append",
                        help="Файл импорта (можно повторять)")
    parser.add_argument("--mode", default="create_or_update",
                        help="Режим Import Center (по умолчанию create_or_update)")
    parser.add_argument("--confirm", action="store_true",
                        help="Применить план. Без флага база не меняется")
    parser.add_argument("--show-rows", type=int, default=0,
                        help="Напечатать первые N строк плана")
    parser.add_argument("--env-file", default=str(REPO_ROOT / ".env"))
    args = parser.parse_args()

    email, password = _admin_credentials(Path(args.env_file))
    base_url = args.base_url.rstrip("/")

    payload = []
    for path_str in args.file:
        path = Path(path_str)
        if not path.exists():
            print(f"Файл не найден: {path}", file=sys.stderr)
            sys.exit(2)
        payload.append(("files", (path.name, path.read_bytes(), "application/octet-stream")))

    with httpx.Client(timeout=180) as client:
        headers = {"Authorization": f"Bearer {login(client, base_url, email, password)}"}

        resp = client.post(f"{base_url}/api/admin/import/batch/preview",
                           files=payload, data={"mode": args.mode}, headers=headers)
        if resp.status_code != 200:
            _fail(resp, "Preview импорта")
        report = resp.json()
        job_id = report.get("job_id")
        print(f"job_id: {job_id}")
        print_report(report, show_rows=args.show_rows)

        if not args.confirm:
            print("\nСухой прогон. Чтобы применить — повторить с --confirm.")
            return

        resp = client.post(f"{base_url}/api/admin/import/batch/{job_id}/confirm",
                           headers=headers)
        if resp.status_code != 200:
            _fail(resp, "Confirm импорта")
        print("\nПрименено:", resp.json().get("summary", resp.json()))


if __name__ == "__main__":
    main()

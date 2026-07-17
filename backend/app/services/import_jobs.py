"""Хранилище import jobs (v5.2).

Интерфейс ImportJobStore изолирует реализацию: сегодня — файловое хранилище
в Docker-томе uploads (single-instance VPS), завтра можно заменить на Redis/S3
без правок API-слоя.

Гарантии:
- job_id криптослучайный (secrets.token_urlsafe);
- job принадлежит конкретному админу;
- TTL (IMPORT_JOB_TTL_SECONDS, по умолчанию 30 минут);
- SHA-256 всех staged-файлов фиксируется на preview и проверяется на confirm;
- секретные пути на диск наружу не отдаются (только имена файлов);
- cleanup: ленивый (при обращении) + sweep протухших при каждом новом preview.
"""
import hashlib
import json
import os
import secrets
import shutil
import time
from abc import ABC, abstractmethod
from pathlib import Path

from app.core.uploads import UPLOAD_DIR

JOBS_DIR = Path(os.environ.get("IMPORT_JOBS_DIR", str(UPLOAD_DIR / "import_jobs")))


class JobError(Exception):
    """Ошибка доступа к job: нет/чужая/протухла/не тот статус."""


class ImportJobStore(ABC):
    @abstractmethod
    def create(self, admin_id: str, plan: dict, staged: dict[str, bytes], ttl_seconds: int) -> dict: ...
    @abstractmethod
    def get(self, job_id: str, admin_id: str) -> dict: ...
    @abstractmethod
    def read_staged(self, job_id: str, admin_id: str, name: str) -> bytes: ...
    @abstractmethod
    def mark_applied(self, job_id: str, admin_id: str, report: dict) -> None: ...
    @abstractmethod
    def delete(self, job_id: str, admin_id: str) -> None: ...
    @abstractmethod
    def sweep_expired(self) -> int: ...


class FileImportJobStore(ImportJobStore):
    """Файловая реализация: uploads/import_jobs/<job_id>/{job.json, staged/*}."""

    def __init__(self, root: Path = JOBS_DIR):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    # ---------- внутреннее ----------
    def _dir(self, job_id: str) -> Path:
        # job_id генерируем сами, но на всякий случай запрещаем разделители
        if not job_id or "/" in job_id or "\\" in job_id or ".." in job_id:
            raise JobError("Некорректный job_id")
        return self.root / job_id

    def _load(self, job_id: str) -> dict:
        path = self._dir(job_id) / "job.json"
        if not path.exists():
            raise JobError("Job не найдена или уже удалена")
        return json.loads(path.read_text(encoding="utf-8"))

    def _save(self, job: dict) -> None:
        path = self._dir(job["job_id"]) / "job.json"
        path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")

    def _check_access(self, job: dict, admin_id: str) -> None:
        if job["admin_id"] != admin_id:
            # Не раскрываем существование чужой job
            raise JobError("Job не найдена или уже удалена")
        if time.time() > job["expires_at"]:
            self._purge(job["job_id"])
            raise JobError("Срок действия job истёк (30 минут) — загрузите пакет заново")

    def _purge(self, job_id: str) -> None:
        shutil.rmtree(self._dir(job_id), ignore_errors=True)

    # ---------- интерфейс ----------
    def create(self, admin_id: str, plan: dict, staged: dict[str, bytes], ttl_seconds: int) -> dict:
        self.sweep_expired()
        job_id = secrets.token_urlsafe(16)
        job_dir = self._dir(job_id)
        (job_dir / "staged").mkdir(parents=True)
        sha256: dict[str, str] = {}
        for name, data in staged.items():
            safe = Path(name).name  # только базовое имя, никаких путей
            (job_dir / "staged" / safe).write_bytes(data)
            sha256[safe] = hashlib.sha256(data).hexdigest()
        now = time.time()
        job = {
            "job_id": job_id, "admin_id": admin_id, "status": "previewed",
            "created_at": now, "expires_at": now + ttl_seconds,
            "files": sorted(sha256), "sha256": sha256,
            "normalized_plan": plan, "report": {},
        }
        self._save(job)
        return job

    def get(self, job_id: str, admin_id: str) -> dict:
        job = self._load(job_id)
        self._check_access(job, admin_id)
        return job

    def read_staged(self, job_id: str, admin_id: str, name: str) -> bytes:
        job = self.get(job_id, admin_id)
        safe = Path(name).name
        path = self._dir(job_id) / "staged" / safe
        if not path.exists():
            raise JobError(f"Staged-файл {safe} отсутствует")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != job["sha256"].get(safe):
            raise JobError(f"SHA-256 файла {safe} не совпадает — файл повреждён")
        return data

    def mark_applied(self, job_id: str, admin_id: str, report: dict) -> None:
        job = self.get(job_id, admin_id)
        job["status"] = "applied"
        job["report"] = report
        job["normalized_plan"] = {}          # план больше не нужен
        self._save(job)
        # staged-файлы сразу удаляем — постоянное хранилище уже получило своё
        shutil.rmtree(self._dir(job_id) / "staged", ignore_errors=True)

    def delete(self, job_id: str, admin_id: str) -> None:
        job = self._load(job_id)
        if job["admin_id"] != admin_id:
            raise JobError("Job не найдена или уже удалена")
        self._purge(job_id)

    def sweep_expired(self) -> int:
        removed = 0
        now = time.time()
        for job_dir in self.root.iterdir() if self.root.exists() else []:
            meta = job_dir / "job.json"
            try:
                job = json.loads(meta.read_text(encoding="utf-8"))
                # applied-job чистим через сутки, previewed — по TTL
                deadline = job["expires_at"] + (86400 if job["status"] == "applied" else 0)
                if now > deadline:
                    shutil.rmtree(job_dir, ignore_errors=True)
                    removed += 1
            except (OSError, ValueError, KeyError):
                shutil.rmtree(job_dir, ignore_errors=True)
                removed += 1
        return removed


def public_job_view(job: dict) -> dict:
    """Ответ наружу: без путей на диск и без внутреннего плана."""
    return {
        "job_id": job["job_id"], "status": job["status"],
        "created_at": job["created_at"], "expires_at": job["expires_at"],
        "files": job["files"],
        "report": job.get("report") or {},
    }


_store: ImportJobStore | None = None


def get_job_store() -> ImportJobStore:
    global _store
    if _store is None:
        _store = FileImportJobStore()
    return _store

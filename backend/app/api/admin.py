from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.user import User

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(get_current_admin)])


@router.get("/stats")
def stats(db: Session = Depends(get_db)):
    users_count = db.execute(select(func.count()).select_from(User)).scalar_one()
    events_count = db.execute(select(func.count()).select_from(AuditLog)).scalar_one()
    return {"users": users_count, "audit_events": events_count}


@router.get("/audit")
def audit_list(db: Session = Depends(get_db), limit: int = 50):
    limit = min(limit, 200)
    rows = db.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)).scalars().all()
    return [
        {"id": r.id, "actor": r.actor, "action": r.action, "ip": r.ip, "created_at": r.created_at.isoformat()}
        for r in rows
    ]

from sqlalchemy.orm import Session

from app.models.audit import AuditLog


def audit(db: Session, actor: str, action: str, detail: str | None = None, ip: str | None = None) -> None:
    db.add(AuditLog(actor=actor, action=action, detail=detail, ip=ip))
    db.commit()

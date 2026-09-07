"""Факт покупки: завершённая заявка с итоговой суммой начисляет баллы.

Главное, что здесь держится: без суммы заявка покупкой не становится, повторное
завершение начисляет заново, а откат возвращает всё начисленное.
"""
import pytest

from app.models.lead import Lead


def test_lead_has_final_total_and_completion_seq(db):
    """Итоговая сумма отдельно от оценочной: estimated_total — то, что собрал
    покупатель, final_total — то, что подтвердил менеджер."""
    lead = Lead(status="new", estimated_total=100_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    assert lead.final_total is None
    assert lead.completion_seq == 0
    assert "final_total" in lead.to_dict()
    assert "completion_seq" in lead.to_dict()

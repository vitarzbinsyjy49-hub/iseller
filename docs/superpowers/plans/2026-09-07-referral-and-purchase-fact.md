# Факт покупки и реферальная программа — план реализации

> **Для агента-исполнителя:** ОБЯЗАТЕЛЬНЫЙ ПОДСКИЛЛ — используй
> `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`, чтобы выполнять этот план задача за задачей.
> Шаги размечены чекбоксами (`- [ ]`).

**Цель:** завершённая заявка с итоговой суммой становится фактом покупки и
автоматически начисляет кэшбек покупателю и процент пригласившему.

**Архитектура:** статус `completed` вместе с обязательным полем `final_total`
— единственный триггер начислений. `loyalty.record()` остаётся примитивом
журнала; реферальные правила живут в отдельном `services/referral.py` и
вызываются после проведения покупки. Ссылка `t.me/<bot>?start=ref_<код>` едет
тем же конвейером атрибуции, что рекламные метки.

**Стек:** FastAPI + SQLAlchemy + PostgreSQL, pytest; фронт React/Vite + vitest;
админка React/Vite.

**Спека:** `docs/superpowers/specs/2026-09-07-referral-and-purchase-fact-design.md`
— читать целиком перед началом, особенно §1.3 (откат), §5.3 (границы защиты).

## Глобальные ограничения

Действуют на КАЖДУЮ задачу, повторять в каждой не будем:

- **Баланса на `users` нет и заводить нельзя.** `balance = SUM(points)` по
  журналу `loyalty_transactions`. Денормализованная копия разъедется молча.
- **Оборот двигают только покупки.** `amount` в журнале заполняется ровно у
  `kind='purchase'`; `_validate()` отвергает `amount` у всех прочих видов.
- **Списка категорий в коде нет** — к этой работе не относится напрямую, но
  правило общее: рубрикация приходит из данных.
- **Чистая логика — в функции без БД, с тестом рядом.** Всё, что считается без
  SQLAlchemy (процент, определение первой покупки, разбор payload), выносится и
  покрывается обычными тестами — как `points_for`, `cartMath`, `navTiles`.
- **Новая колонка в таблице из `REQUIRED_SCHEMA`** (`app/scripts/bot_polling.py`)
  обязана быть добавлена и туда. Тест `test_required_schema_covers_every_mini_migration_column`
  ловит это **только для таблиц, уже перечисленных** в `REQUIRED_SCHEMA` —
  сейчас это `notifications`, `product_favorites`, `carts`, `users`,
  `fx_rate_history`. Для новых таблиц он молчит.
- **Новые таблицы создаёт `Base.metadata.create_all`.** Отдельная миграция
  нужна только для колонок в СУЩЕСТВУЮЩИХ таблицах — в
  `_apply_demo_migrations` (`app/main.py`), строками
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`.
- **Тач-таргет ≥ 44×44** на фронте (`min-h-11`), даже если элемент визуально ниже.
- **Не обещать того, чего backend не отдаёт.** Нет данных — блок не рисуется.
- Проверки перед каждым коммитом: `cd backend && python -m pytest -q`.
  Перед коммитами, трогающими фронт или админку, дополнительно
  `npx tsc --noEmit && npx vitest run && npm run build` в соответствующем каталоге.

## Карта файлов

| файл | ответственность | фаза |
|---|---|---|
| `backend/app/services/loyalty.py` | журнал: минус для корректировок, явный `rate_bps`, вид `referral` | 1 |
| `backend/app/models/lead.py` | `final_total`, `completion_seq` | 2 |
| `backend/app/main.py` | мини-миграции новых колонок | 2, 4 |
| `backend/app/api/admin_crm.py` | требование суммы, вызов начислений и отката | 2 |
| `backend/app/services/purchase.py` | **создать** — начисление и откат по заявке | 2 |
| `backend/app/models/loyalty_settings.py` | **создать** — настройки одной строкой | 3 |
| `backend/app/services/settings.py` | **создать** — чтение настроек со значениями по умолчанию | 3 |
| `backend/app/api/admin_settings.py` | **создать** — чтение и запись настроек с аудитом | 3 |
| `admin/src/Settings.tsx` | **создать** — экран настроек | 3 |
| `backend/app/models/user.py` | `referral_code`, `referred_by_user_id` | 4 |
| `backend/app/models/ad_touch.py` | `kind` | 4 |
| `backend/app/scripts/bot_polling.py` | `REQUIRED_SCHEMA` | 4 |
| `backend/app/services/telegram_bot.py` | `parse_ref_payload` | 4 |
| `backend/app/services/referral.py` | **создать** — код, связь, расчёт и проведение выплат | 4, 5 |
| `backend/app/api/auth.py` | захват связи при регистрации | 4 |
| `backend/app/api/referral.py` | **создать** — `GET /referral/me` | 6 |
| `frontend/src/lib/referral.ts` | **создать** — типы и чистые функции экрана | 6 |
| `frontend/src/pages/Profile.tsx` | блок приглашений | 6 |
| `frontend/src/lib/roadmap.ts` | текст карточки `referral` | 6 |
| `admin/src/Referrals.tsx` | **создать** — «кто кого привёл» | 6 |

---

# Фаза 1. Фундамент журнала

Три правки в `loyalty.py`, без которых остальные фазы построить нельзя.

### Задача 1: корректировка может увести баланс в минус

**Файлы:**
- Изменить: `backend/app/services/loyalty.py:255-260` (проверка баланса в `record`)
- Тест: `backend/tests/test_loyalty.py`

**Интерфейсы:**
- Отдаёт: поведение `record(kind='correction', points=<отрицательное>)` —
  проходит даже когда `balance + points < 0`.

**Почему:** проверка «баланс не уходит в минус» применяется ко ВСЕМ видам
операций. При откате отменённой сделки она сделает возврат невозможным ровно
тогда, когда он нужен — если баллы успели потратить. Это готовый вектор
накрутки: потратил начисленное, и откатить нельзя.

- [ ] **Шаг 1: написать падающий тест**

В `backend/tests/test_loyalty.py`, рядом с существующими тестами баланса:

```python
def test_correction_may_drive_balance_negative(db, ctx):
    """Откат несостоявшейся сделки обязан пройти, даже если баллы потрачены.

    Иначе накрутка защищена собственной защитой магазина: потратил начисленное
    — и отнять уже нельзя. Отрицательный баланс честнее молчания: он виден и
    гасится из будущих начислений.
    """
    user = ctx["user"]
    loyalty.record(db, user_id=user.id, kind="bonus", points=1000)
    loyalty.record(
        db, user_id=user.id, kind="spend", points=-900, comment="потратил",
    )
    assert loyalty.summary(db, user.id)["balance"] == 100

    loyalty.record(
        db, user_id=user.id, kind="correction", points=-1000,
        comment="заявка 42 вышла из статуса «завершена»",
    )
    assert loyalty.summary(db, user.id)["balance"] == -900


def test_spend_still_cannot_drive_balance_negative(db, ctx):
    """Послабление касается ТОЛЬКО корректировок: потратить больше, чем есть,
    по-прежнему нельзя."""
    user = ctx["user"]
    loyalty.record(db, user_id=user.id, kind="bonus", points=100)
    with pytest.raises(loyalty.LoyaltyError):
        loyalty.record(
            db, user_id=user.id, kind="spend", points=-500, comment="слишком много",
        )
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_loyalty.py::test_correction_may_drive_balance_negative -v`
Ожидается: FAIL с `LoyaltyError: Недостаточно баллов`.

- [ ] **Шаг 3: минимальная правка**

В `record()` заменить проверку баланса:

```python
    # Корректировка — единственный вид, которому минус разрешён. Ею
    # откатывают начисления по сделке, которая не состоялась, и если человек
    # успел потратить баллы, запрет минуса сделал бы откат невозможным ровно
    # тогда, когда он нужен. Отрицательный баланс — штатное состояние: он
    # виден человеку и гасится из будущих начислений.
    if kind != "correction" and current["balance"] + int(points) < 0:
        raise LoyaltyError(
            f"Недостаточно баллов: на счету {current['balance']}, "
            f"списать пытаются {abs(int(points))}"
        )
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_loyalty.py -v`
Ожидается: PASS, включая оба новых теста и все прежние.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/loyalty.py backend/tests/test_loyalty.py
git commit -m "feat(лояльность): корректировка может увести баланс в минус"
```

---

### Задача 2: явная ставка и вид операции `referral`

**Файлы:**
- Изменить: `backend/app/services/loyalty.py:34` (`LOYALTY_KINDS`), `219-250` (`record`)
- Тест: `backend/tests/test_loyalty.py`

**Интерфейсы:**
- Потребляет: ничего.
- Отдаёт: `loyalty.record(..., kind="referral", points=N, rate_bps=100)` —
  сохраняет ставку снапшотом; `LOYALTY_KINDS` содержит `"referral"`.

**Почему:** ставка выплаты настраивается в админке и со временем меняется.
Без снапшота через год будет невозможно понять, по какому проценту платили —
та же причина, по которой `rate_bps` снапшотится у кэшбека, а `added_price` у
корзины. Отдельный вид, а не существующий `bonus`: `bonus` означает ручной
подарок менеджера, и смешивать его с автоматическими выплатами значит потерять
возможность посчитать любую из двух величин отдельно.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_referral_kind_keeps_rate_snapshot(db, ctx):
    """Ставка выплаты настраивается и со временем меняется — в операции
    остаётся та, по которой заплатили на самом деле."""
    user = ctx["user"]
    row = loyalty.record(
        db, user_id=user.id, kind="referral", points=1000, rate_bps=100,
        comment="1% с покупки друга",
    )
    assert row.kind == "referral"
    assert row.rate_bps == 100
    assert row.amount is None


def test_referral_does_not_move_turnover(db, ctx):
    """Реферальный доход не поднимает уровень: иначе уровень перестанет
    означать «сколько человек у нас купил»."""
    user = ctx["user"]
    loyalty.record(
        db, user_id=user.id, kind="referral", points=200_000, rate_bps=100,
        comment="процент",
    )
    assert loyalty.summary(db, user.id)["lifetime_spent"] == 0
    assert loyalty.summary(db, user.id)["level"]["key"] == "start"
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_loyalty.py::test_referral_kind_keeps_rate_snapshot -v`
Ожидается: FAIL — `LoyaltyError: Неизвестный вид операции: referral`, а затем
`TypeError` про неизвестный аргумент `rate_bps`.

- [ ] **Шаг 3: минимальная правка**

В `loyalty.py` расширить список видов:

```python
# referral — автоматическая выплата реферальной программы: процент
# пригласившему и приветственные баллы приглашённому. Отдельно от bonus:
# bonus — ручной подарок менеджера, и в отчёте это разные статьи.
LOYALTY_KINDS = ("purchase", "spend", "bonus", "correction", "referral")
```

В сигнатуру `record()` добавить параметр и заменить вычисление ставки:

```python
def record(
    db: Session,
    *,
    user_id: int,
    kind: str,
    points: int | None = None,
    amount: float | Decimal | None = None,
    comment: str | None = None,
    created_by: str | None = None,
    idempotency_key: str | None = None,
    rate_bps: int | None = None,
) -> LoyaltyTransaction:
```

```python
    money = Decimal(str(amount)) if amount is not None else None
    current = summary(db, user_id)
    # Ставка покупки берётся из уровня и перебить её нельзя: она следствие
    # оборота. Для реферальной выплаты ставку задаёт настройка, поэтому она
    # приходит снаружи — но снапшотится точно так же.
    if kind == "purchase":
        rate_bps = current["level"]["rate_bps"]
    elif kind != "referral":
        rate_bps = None
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_loyalty.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/loyalty.py backend/tests/test_loyalty.py
git commit -m "feat(лояльность): вид операции referral и явная ставка снапшотом"
```

---

# Фаза 2. Факт покупки

### Задача 3: колонки заявки — итоговая сумма и счётчик завершений

**Файлы:**
- Изменить: `backend/app/models/lead.py` (после `estimated_total`, строка ~83)
- Изменить: `backend/app/main.py` (`_apply_demo_migrations`, рядом со строкой 145)
- Тест: `backend/tests/test_purchase_fact.py` (**создать**)

**Интерфейсы:**
- Отдаёт: `Lead.final_total: Decimal | None`, `Lead.completion_seq: int`,
  оба в `Lead.to_dict()`.

**Почему `completion_seq`:** ключ идемпотентности начисления выводится из
заявки. Если ключом будет `lead_<id>_purchase`, сценарий «завершили → откатили
→ завершили снова» сломается МОЛЧА: `record()` найдёт операцию по совпавшему
ключу и вернёт старую вместо новой — ни исключения, ни лога, просто баллы не
начислены. Счётчик попыток в ключе закрывает это.

`leads` в `REQUIRED_SCHEMA` не входит и добавлять её туда не нужно: фоновые
задачи бота (скан корзин, скан избранного, курс) заявки не читают.

- [ ] **Шаг 1: написать падающий тест**

Создать `backend/tests/test_purchase_fact.py`:

```python
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
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py -v`
Ожидается: FAIL — `AttributeError: 'Lead' object has no attribute 'final_total'`.

- [ ] **Шаг 3: добавить колонки**

В `backend/app/models/lead.py` после `estimated_total`:

```python
    # Фактическая сумма сделки — то, что менеджер подтвердил при завершении.
    # НЕ значение по умолчанию от estimated_total: админка подставляет оценку
    # в форму подсказкой, но в базу попадает подтверждённое. Совпадение полей
    # тогда означает «менеджер согласился», а не «никто не смотрел».
    final_total: Mapped[float | None] = mapped_column(Numeric(12, 2))
    # Сколько раз заявка входила в статус «завершена». Участвует в ключе
    # идемпотентности начислений: без него повторное завершение после отката
    # вернуло бы старую операцию вместо новой и не начислило бы ничего — молча.
    completion_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
```

Убедиться, что `Integer` импортирован из `sqlalchemy` в шапке файла; если нет —
добавить в существующий импорт.

В `to_dict()` рядом с `estimated_total`:

```python
            "final_total": float(self.final_total) if self.final_total is not None else None,
            "completion_seq": self.completion_seq or 0,
```

В `backend/app/main.py`, в `_apply_demo_migrations`, рядом с остальными
`ALTER TABLE leads`:

```python
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS final_total NUMERIC(12, 2)",
        "ALTER TABLE leads ADD COLUMN IF NOT EXISTS completion_seq INTEGER NOT NULL DEFAULT 0",
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py tests/test_bot_tick.py -v`
Ожидается: PASS. `test_bot_tick.py` проверяется отдельно: он держит
`REQUIRED_SCHEMA` сомкнутым с мини-миграциями и обязан остаться зелёным.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/models/lead.py backend/app/main.py backend/tests/test_purchase_fact.py
git commit -m "feat(заявки): итоговая сумма сделки и счётчик завершений"
```

---

### Задача 4: переход в «завершена» требует итоговую сумму

**Файлы:**
- Изменить: `backend/app/api/admin_crm.py:182-213` (`update_lead`), схема `LeadStatusIn`
- Тест: `backend/tests/test_purchase_fact.py`

**Интерфейсы:**
- Потребляет: `Lead.final_total`, `Lead.completion_seq` (задача 3).
- Отдаёт: `PATCH /api/admin/leads/{id}` принимает `final_total: float | None`;
  переход в `completed` без суммы отвечает 400.

**Почему:** заявка без итоговой суммы покупкой не является. Пропустить её
значит вернуться к начислению за намерение — ровно к тому, что в проекте
запрещено осознанно (`docs/context/cart-and-loyalty.md`).

- [ ] **Шаг 1: написать падающий тест**

Дописать в `backend/tests/test_purchase_fact.py` (фикстуру админского клиента
взять по образцу `backend/tests/test_admin_cart_orders.py` — там уже есть
переопределение `get_current_admin`):

```python
def test_completing_without_final_total_is_rejected(admin_client, db):
    """Заявка без подтверждённой суммы покупкой не становится."""
    lead = Lead(status="confirmed", estimated_total=100_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(f"/api/admin/leads/{lead.id}", json={"status": "completed"})
    assert resp.status_code == 400
    assert "сумм" in resp.json()["detail"].lower()

    db.refresh(lead)
    assert lead.status == "confirmed", "статус не должен был поменяться"


def test_completing_with_final_total_bumps_seq(admin_client, db):
    lead = Lead(status="confirmed", estimated_total=100_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 98_000},
    )
    assert resp.status_code == 200
    db.refresh(lead)
    assert lead.status == "completed"
    assert float(lead.final_total) == 98_000
    assert lead.completion_seq == 1


def test_final_total_must_be_positive(admin_client, db):
    lead = Lead(status="confirmed")
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 0},
    )
    assert resp.status_code == 400
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py -v`
Ожидается: FAIL — переход проходит со статусом 200, поля `final_total` схема не
знает.

- [ ] **Шаг 3: реализация**

В схеме `LeadStatusIn` (найти её импорт в шапке `admin_crm.py` и файл, где она
объявлена — `app/schemas/`) добавить поле:

```python
    # Итоговая сумма сделки. Обязательна при переходе в «завершена»: именно она
    # превращает заявку в покупку. Оценочный estimated_total для начислений не
    # используется нигде.
    final_total: float | None = None
```

В `update_lead`, внутри ветки `if body.status is not None:`, **до** присваивания
статуса:

```python
        if body.status == "completed" and lead.status != "completed":
            total = body.final_total if body.final_total is not None else lead.final_total
            if total is None or float(total) <= 0:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Для завершения заявки укажите итоговую сумму сделки больше нуля",
                )
            lead.final_total = total
            # Счётчик растёт на КАЖДОМ входе в «завершена»: он участвует в ключе
            # идемпотентности начислений, и без него повторное завершение после
            # отката молча вернуло бы старую операцию вместо новой.
            lead.completion_seq = (lead.completion_seq or 0) + 1
```

Отдельной строкой, вне ветки статуса, разрешить правку суммы у уже завершённой
заявки без смены статуса:

```python
    if body.final_total is not None and body.status is None:
        lead.final_total = body.final_total
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/api/admin_crm.py backend/app/schemas backend/tests/test_purchase_fact.py
git commit -m "feat(заявки): завершение требует подтверждённую итоговую сумму"
```

---

### Задача 5: автоматическое начисление кэшбека при завершении

**Файлы:**
- Создать: `backend/app/services/purchase.py`
- Изменить: `backend/app/api/admin_crm.py` (`update_lead`)
- Тест: `backend/tests/test_purchase_fact.py`

**Интерфейсы:**
- Потребляет: `loyalty.record` (фаза 1), `Lead.final_total`,
  `Lead.completion_seq`.
- Отдаёт:
  - `purchase.accrue_for_lead(db, lead, actor: str) -> None` — проводит
    кэшбек покупателю по завершённой заявке;
  - `purchase.purchase_key(lead_id: int, seq: int) -> str` — ключ
    идемпотентности вида `lead_<id>_<seq>_purchase`.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_completed_lead_accrues_cashback(admin_client, db, ctx):
    """Кэшбек начисляется по подтверждённой сумме, а не по оценочной."""
    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id, estimated_total=200_000)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    # «Старт» — 0,25%: 100 000 * 25 // 10000 = 250
    assert loyalty.summary(db, user.id)["balance"] == 250
    assert loyalty.summary(db, user.id)["lifetime_spent"] == 100_000


def test_saving_completed_lead_twice_does_not_double_cashback(admin_client, db, ctx):
    """Двойное сохранение статуса не имеет права дать двойной кэшбек."""
    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    for _ in range(2):
        admin_client.patch(
            f"/api/admin/leads/{lead.id}",
            json={"status": "completed", "final_total": 100_000},
        )
    assert loyalty.summary(db, user.id)["balance"] == 250


def test_lead_without_user_accrues_nothing(admin_client, db):
    """Заявку мог завести менеджер вручную — покупателя в системе нет.
    Это норма, а не ошибка."""
    lead = Lead(status="confirmed", user_id=None)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    assert resp.status_code == 200
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py::test_completed_lead_accrues_cashback -v`
Ожидается: FAIL — баланс 0.

- [ ] **Шаг 3: реализация**

Создать `backend/app/services/purchase.py`:

```python
"""Завершённая заявка как факт покупки.

Прежний запрет «автоматики на статусе заявки нет» (docs/context/cart-and-loyalty.md)
касался статуса «заявка создана» и остаётся в силе: человек нажал кнопку, платить
не за что. Здесь основание другое — терминальный статус ВМЕСТЕ с итоговой суммой,
которую подтвердил менеджер. Оценочный estimated_total не используется нигде.

Ключи идемпотентности включают номер попытки завершения (Lead.completion_seq):
без него сценарий «завершили -> откатили -> завершили снова» вернул бы старую
операцию вместо новой и не начислил бы ничего, не сказав об этом ни словом.
"""
from sqlalchemy.orm import Session

from app.models.lead import Lead
from app.services import loyalty


def purchase_key(lead_id: int, seq: int) -> str:
    return f"lead_{lead_id}_{seq}_purchase"


def accrue_for_lead(db: Session, lead: Lead, actor: str) -> None:
    """Провести кэшбек покупателю по завершённой заявке.

    Молча ничего не делает, если покупателя нет в системе: заявку мог завести
    менеджер вручную, и это норма.
    """
    if lead.user_id is None or lead.final_total is None:
        return
    loyalty.record(
        db,
        user_id=lead.user_id,
        kind="purchase",
        amount=lead.final_total,
        comment=f"Заявка {lead.id} завершена",
        created_by=actor,
        idempotency_key=purchase_key(lead.id, lead.completion_seq or 0),
    )
```

В `admin_crm.py`, в `update_lead`, **после** `_notify_status_change(...)` и
внутри той же ветки смены статуса:

```python
            if body.status == "completed":
                purchase.accrue_for_lead(db, lead, actor=f"admin:{admin}")
```

Добавить импорт `from app.services import purchase` в шапку файла.

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/purchase.py backend/app/api/admin_crm.py backend/tests/test_purchase_fact.py
git commit -m "feat(заявки): завершённая сделка начисляет кэшбек автоматически"
```

---

### Задача 6: откат начислений при уходе из «завершена»

**Файлы:**
- Изменить: `backend/app/services/purchase.py`, `backend/app/api/admin_crm.py`
- Тест: `backend/tests/test_purchase_fact.py`

**Интерфейсы:**
- Потребляет: `purchase.purchase_key`, послабление минуса для `correction`
  (задача 1).
- Отдаёт: `purchase.revert_for_lead(db, lead, actor: str) -> None`.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_leaving_completed_reverts_cashback(admin_client, db, ctx):
    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    assert loyalty.summary(db, user.id)["balance"] == 250

    admin_client.patch(f"/api/admin/leads/{lead.id}", json={"status": "cancelled"})
    assert loyalty.summary(db, user.id)["balance"] == 0
    assert loyalty.summary(db, user.id)["lifetime_spent"] == 0


def test_revert_works_even_when_points_already_spent(admin_client, db, ctx):
    """Главный сценарий накрутки: начислили, потратили, отменили. Откат обязан
    пройти и увести баланс в минус — иначе защита магазина защищает накрутку."""
    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    loyalty.record(db, user_id=user.id, kind="spend", points=-250, comment="потратил")
    assert loyalty.summary(db, user.id)["balance"] == 0

    admin_client.patch(f"/api/admin/leads/{lead.id}", json={"status": "cancelled"})
    assert loyalty.summary(db, user.id)["balance"] == -250


def test_completing_again_after_revert_accrues_anew(admin_client, db, ctx):
    """Ключ идемпотентности включает номер попытки: иначе второе завершение
    молча вернуло бы старую операцию и не начислило ничего."""
    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    admin_client.patch(f"/api/admin/leads/{lead.id}", json={"status": "cancelled"})
    admin_client.patch(
        f"/api/admin/leads/{lead.id}",
        json={"status": "completed", "final_total": 100_000},
    )
    assert loyalty.summary(db, user.id)["balance"] == 250
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py::test_leaving_completed_reverts_cashback -v`
Ожидается: FAIL — баланс остался 250.

- [ ] **Шаг 3: реализация**

В `purchase.py` добавить:

```python
def revert_for_lead(db: Session, lead: Lead, actor: str) -> None:
    """Откатить всё, что начислено по заявке на текущей попытке завершения.

    Корректировке разрешён минус (см. loyalty.record): если баллы успели
    потратить, запрет сделал бы откат невозможным ровно тогда, когда он нужен.
    """
    seq = lead.completion_seq or 0
    key = purchase_key(lead.id, seq)
    original = loyalty.transaction_by_key(db, key)
    if original is None:
        return
    loyalty.record(
        db,
        user_id=original.user_id,
        kind="correction",
        points=-original.points,
        comment=f"Заявка {lead.id} вышла из статуса «завершена»",
        created_by=actor,
        idempotency_key=f"{key}_revert",
    )
```

В `loyalty.py` рядом с приватным `_existing` добавить публичный поиск по ключу
(`_existing` требует `user_id`, а откату он заранее неизвестен):

```python
def transaction_by_key(db: Session, key: str) -> LoyaltyTransaction | None:
    """Операция по ключу идемпотентности. Ключ уникален в пределах
    пользователя, но наши ключи содержат id заявки и номер попытки, поэтому
    глобально они тоже не повторяются."""
    return db.execute(
        select(LoyaltyTransaction).where(LoyaltyTransaction.idempotency_key == key)
    ).scalars().first()
```

В `admin_crm.py`, в той же ветке смены статуса:

```python
            if body.status == "completed":
                purchase.accrue_for_lead(db, lead, actor=f"admin:{admin}")
            elif previous == "completed":
                purchase.revert_for_lead(db, lead, actor=f"admin:{admin}")
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_purchase_fact.py -v`
Ожидается: PASS, все шесть тестов фазы.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/purchase.py backend/app/services/loyalty.py backend/app/api/admin_crm.py backend/tests/test_purchase_fact.py
git commit -m "feat(заявки): откат начислений при уходе из статуса «завершена»"
```

---

# Фаза 3. Настройки

Идёт раньше выплат, чтобы рубильник существовал до того, как появится что
выключать.

### Задача 7: таблица настроек и аксессор

**Файлы:**
- Создать: `backend/app/models/loyalty_settings.py`, `backend/app/services/settings.py`
- Изменить: `backend/app/models/__init__.py` (регистрация модели, если там есть список)
- Тест: `backend/tests/test_loyalty_settings.py` (**создать**)

**Интерфейсы:**
- Отдаёт: `settings.loyalty(db) -> LoyaltySettings` — всегда возвращает объект
  со значениями по умолчанию, даже если строки в базе нет.

**Почему явные колонки, а не «ключ-значение»:** универсальное хранилище не
типизируется и не валидируется, и через полгода содержит строку `"1%"` там, где
код ждёт число. Настроек три, и растут они медленнее кода вокруг них.

- [ ] **Шаг 1: написать падающий тест**

```python
"""Настройки лояльности: одна строка, значения по умолчанию, рубильник."""
from app.services import settings


def test_defaults_without_row(db):
    """Отсутствие строки — не ошибка: это значения по умолчанию."""
    s = settings.loyalty(db)
    assert s.referral_rate_bps == 100      # 1%
    assert s.welcome_bonus_points == 1000
    assert s.auto_accrual_enabled is True


def test_saved_values_win(db):
    from app.models.loyalty_settings import LoyaltySettings

    db.add(LoyaltySettings(id=1, referral_rate_bps=250, welcome_bonus_points=500,
                           auto_accrual_enabled=False))
    db.commit()

    s = settings.loyalty(db)
    assert s.referral_rate_bps == 250
    assert s.welcome_bonus_points == 500
    assert s.auto_accrual_enabled is False
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_loyalty_settings.py -v`
Ожидается: FAIL — модуля нет.

- [ ] **Шаг 3: реализация**

Создать `backend/app/models/loyalty_settings.py`:

```python
"""Настройки программы лояльности — одна строка (id=1).

Явные колонки, а не универсальный «ключ-значение»: последний не типизируется и
не валидируется, и через полгода содержит строку «1%» там, где код ждёт число.
Настроек три, и растут они медленнее, чем код вокруг них.
"""
from sqlalchemy import Boolean, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class LoyaltySettings(Base):
    __tablename__ = "loyalty_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    #: Ставка выплаты пригласившему в сотых процента: 100 = 1%.
    referral_rate_bps: Mapped[int] = mapped_column(Integer, default=100, server_default="100")
    #: Приветственные баллы приглашённому за его первую покупку.
    welcome_bonus_points: Mapped[int] = mapped_column(Integer, default=1000, server_default="1000")
    #: Главный рубильник автоматических начислений. Ручное начисление из
    #: карточки клиента работает всегда — это путь отхода.
    auto_accrual_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true",
    )
```

Создать `backend/app/services/settings.py`:

```python
"""Чтение настроек лояльности.

Отсутствие строки трактуется как значения по умолчанию, а не как ошибка: так
свежая база и база после отката ведут себя одинаково.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.loyalty_settings import LoyaltySettings


def loyalty(db: Session) -> LoyaltySettings:
    row = db.execute(select(LoyaltySettings).where(LoyaltySettings.id == 1)).scalar_one_or_none()
    return row if row is not None else LoyaltySettings(id=1)
```

Если в `backend/app/models/__init__.py` перечислены модели для
`create_all` — добавить туда импорт `LoyaltySettings`. Проверить командой:
`grep -n "import" backend/app/models/__init__.py`.

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_loyalty_settings.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/models/loyalty_settings.py backend/app/services/settings.py backend/app/models/__init__.py backend/tests/test_loyalty_settings.py
git commit -m "feat(лояльность): настройки программы одной строкой"
```

---

### Задача 8: API настроек с аудитом и рубильник в начислении

**Файлы:**
- Создать: `backend/app/api/admin_settings.py`
- Изменить: `backend/app/main.py` (регистрация роутера),
  `backend/app/services/purchase.py` (проверка рубильника)
- Тест: `backend/tests/test_loyalty_settings.py`

**Интерфейсы:**
- Отдаёт: `GET /api/admin/settings/loyalty`,
  `PUT /api/admin/settings/loyalty` (тело: `referral_rate_bps`,
  `welcome_bonus_points`, `auto_accrual_enabled`).

- [ ] **Шаг 1: написать падающий тест**

```python
def test_admin_reads_and_writes_settings(admin_client, db):
    assert admin_client.get("/api/admin/settings/loyalty").json()["referral_rate_bps"] == 100

    resp = admin_client.put("/api/admin/settings/loyalty", json={
        "referral_rate_bps": 200, "welcome_bonus_points": 500,
        "auto_accrual_enabled": True,
    })
    assert resp.status_code == 200
    assert settings.loyalty(db).referral_rate_bps == 200


def test_settings_change_is_audited(admin_client, db):
    from app.models.audit import AuditLog
    from sqlalchemy import select

    admin_client.put("/api/admin/settings/loyalty", json={
        "referral_rate_bps": 300, "welcome_bonus_points": 1000,
        "auto_accrual_enabled": True,
    })
    rows = db.execute(
        select(AuditLog).where(AuditLog.action == "loyalty_settings_changed")
    ).scalars().all()
    assert len(rows) == 1
    assert "100" in rows[0].detail and "300" in rows[0].detail


def test_rate_must_be_sane(admin_client):
    for bad in (-1, 10_001):
        resp = admin_client.put("/api/admin/settings/loyalty", json={
            "referral_rate_bps": bad, "welcome_bonus_points": 1000,
            "auto_accrual_enabled": True,
        })
        assert resp.status_code == 400


def test_switch_off_stops_auto_accrual(admin_client, db, ctx):
    """Рубильник останавливает автоматику, но сумма и счётчик проставляются:
    это свойства заявки, а не начислений."""
    from app.models.lead import Lead
    from app.models.loyalty_settings import LoyaltySettings

    db.add(LoyaltySettings(id=1, auto_accrual_enabled=False))
    db.commit()

    user = ctx["user"]
    lead = Lead(status="confirmed", user_id=user.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(f"/api/admin/leads/{lead.id}",
                       json={"status": "completed", "final_total": 100_000})
    db.refresh(lead)
    assert float(lead.final_total) == 100_000
    assert lead.completion_seq == 1
    assert loyalty.summary(db, user.id)["balance"] == 0
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_loyalty_settings.py -v`
Ожидается: FAIL — 404 на неизвестном маршруте.

- [ ] **Шаг 3: реализация**

Создать `backend/app/api/admin_settings.py` по образцу существующих админских
роутеров (взять шапку и зависимость `get_current_admin` из
`backend/app/api/admin_promo.py`):

```python
"""Настройки программы лояльности: чтение, запись, аудит.

Каждое изменение попадает в аудит со старым и новым значением: ставка выплаты
— это деньги, и через полгода надо уметь ответить, кто и когда её поменял.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin
from app.db.session import get_db
from app.models.audit import AuditLog
from app.models.loyalty_settings import LoyaltySettings
from app.services import settings as settings_service

router = APIRouter(prefix="/admin/settings", tags=["admin"])


class LoyaltySettingsIn(BaseModel):
    referral_rate_bps: int
    welcome_bonus_points: int
    auto_accrual_enabled: bool


def _to_dict(row: LoyaltySettings) -> dict:
    return {
        "referral_rate_bps": row.referral_rate_bps,
        "welcome_bonus_points": row.welcome_bonus_points,
        "auto_accrual_enabled": row.auto_accrual_enabled,
    }


@router.get("/loyalty")
def read_loyalty_settings(db: Session = Depends(get_db), admin: str = Depends(get_current_admin)):
    return _to_dict(settings_service.loyalty(db))


@router.put("/loyalty")
def write_loyalty_settings(
    body: LoyaltySettingsIn,
    db: Session = Depends(get_db),
    admin: str = Depends(get_current_admin),
):
    # Потолок 10000 bps = 100%: выплата больше суммы покупки — это опечатка,
    # а не намерение. Ноль допустим: способ выключить процент, оставив
    # приветственный бонус.
    if not (0 <= body.referral_rate_bps <= 10_000):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ставка должна быть от 0 до 10000 сотых процента")
    if not (0 <= body.welcome_bonus_points <= 1_000_000):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Приветственный бонус должен быть от 0 до 1000000 баллов")

    row = db.execute(select(LoyaltySettings).where(LoyaltySettings.id == 1)).scalar_one_or_none()
    if row is None:
        row = LoyaltySettings(id=1)
        db.add(row)
    before = _to_dict(row)

    row.referral_rate_bps = body.referral_rate_bps
    row.welcome_bonus_points = body.welcome_bonus_points
    row.auto_accrual_enabled = body.auto_accrual_enabled

    db.add(AuditLog(
        actor=f"admin:{admin}",
        action="loyalty_settings_changed",
        detail=f"from={before};to={_to_dict(row)}",
    ))
    db.commit()
    db.refresh(row)
    return _to_dict(row)
```

Зарегистрировать роутер в `backend/app/main.py` рядом с остальными админскими
(найти строки `app.include_router(admin_promo.router` и добавить такую же).

В `purchase.accrue_for_lead` в самое начало:

```python
    if not settings.loyalty(db).auto_accrual_enabled:
        return
```

с импортом `from app.services import settings`.

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_loyalty_settings.py tests/test_purchase_fact.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/api/admin_settings.py backend/app/main.py backend/app/services/purchase.py backend/tests/test_loyalty_settings.py
git commit -m "feat(админка): настройки лояльности с аудитом и рубильник автоначисления"
```

---

### Задача 9: экран настроек в админке

**Файлы:**
- Создать: `admin/src/Settings.tsx`
- Изменить: `admin/src/App.tsx:123` (список вкладок)

**Интерфейсы:**
- Потребляет: `GET`/`PUT /api/admin/settings/loyalty` (задача 8).

- [ ] **Шаг 1: посмотреть образец**

Прочитать `admin/src/PromoCodes.tsx` целиком — оттуда берутся приёмы работы с
API, состояние формы и оформление. Новый экран обязан выглядеть как соседние, а
не как отдельное приложение.

- [ ] **Шаг 2: создать экран**

`admin/src/Settings.tsx` — форма с тремя полями:

- «Процент пригласившему» — вводится **процентами** (`1`, `1.5`), хранится в
  сотых (`100`, `150`). Пересчёт на границе с API, как в программе лояльности;
- «Приветственные баллы другу» — целое число;
- «Автоматические начисления» — переключатель, с подписью, что ручное
  начисление из карточки клиента продолжает работать.

Кнопка сохранения показывает результат и не гасит форму при ошибке — текст
ошибки приходит из `detail` ответа.

- [ ] **Шаг 3: зарегистрировать вкладку**

В `admin/src/App.tsx` рядом со строкой `{ key: "customers", label: "Клиенты" }`
добавить `{ key: "settings", label: "Настройки" }` и отрисовать `<Settings />`
там, где обрабатываются остальные ключи.

- [ ] **Шаг 4: проверить сборку**

Запустить: `cd admin && npx tsc --noEmit && npm run build`
Ожидается: без ошибок.

- [ ] **Шаг 5: коммит**

```bash
git add admin/src/Settings.tsx admin/src/App.tsx
git commit -m "feat(админка): экран настроек программы лояльности"
```

---

# Фаза 4. Реферальная связь

### Задача 10: колонки пользователя и первого касания

**Файлы:**
- Изменить: `backend/app/models/user.py`, `backend/app/models/ad_touch.py`,
  `backend/app/main.py`, `backend/app/scripts/bot_polling.py`
- Тест: `backend/tests/test_referral.py` (**создать**)

**Интерфейсы:**
- Отдаёт: `User.referral_code: str | None`,
  `User.referred_by_user_id: int | None`, `AdTouch.kind: str`.

**ВНИМАНИЕ — самая дорогая ошибка этой фазы.** Обе колонки `users` обязаны
попасть в `REQUIRED_SCHEMA` (`app/scripts/bot_polling.py`), иначе деплой
уронит бота полноэкранным `UndefinedColumn`: скан корзин джойнит `users` и
тянет все её колонки через ORM. Тест
`test_required_schema_covers_every_mini_migration_column` это поймает.

**`ad_touches` тест НЕ поймает** — таблицы нет в `REQUIRED_SCHEMA`, а он
проверяет только перечисленные. Добавить её туда осознанно: бот пишет
`ad_touches` при `/start`, миграции же выполняет API-контейнер, и бот может
подняться раньше.

- [ ] **Шаг 1: написать падающий тест**

Создать `backend/tests/test_referral.py`:

```python
"""Реферальная программа: код, связь, выплаты.

Главное, что здесь держится: связь ставится один раз и не переписывается,
самоприглашение невозможно, выплата не удваивается и не двигает оборот.
"""
import pytest

from app.models.user import User


def test_user_has_referral_columns(db):
    user = User(telegram_id=900)
    db.add(user)
    db.commit()
    db.refresh(user)

    assert user.referral_code is None
    assert user.referred_by_user_id is None


def test_required_schema_knows_new_user_columns():
    """Колонка в users, о которой не знает бот, роняет деплой."""
    from app.scripts import bot_polling as bp

    assert "referral_code" in bp.REQUIRED_SCHEMA["users"]
    assert "referred_by_user_id" in bp.REQUIRED_SCHEMA["users"]


def test_required_schema_covers_ad_touches():
    """Бот пишет ad_touches при /start, а миграции выполняет API-контейнер:
    бот может подняться раньше. Тест синхронизации это не ловит — таблицы нет
    в его поле зрения, пока мы её туда не внесём."""
    from app.scripts import bot_polling as bp

    assert "kind" in bp.REQUIRED_SCHEMA["ad_touches"]
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_referral.py -v`
Ожидается: FAIL — `AttributeError` на `referral_code`, `KeyError: 'ad_touches'`.

- [ ] **Шаг 3: реализация**

В `backend/app/models/user.py` рядом с `acquisition_source`:

```python
    #: Личный код приглашения. Выдаётся лениво — при первом открытии экрана
    #: приглашений, а не всем существующим пользователям разом.
    referral_code: Mapped[str | None] = mapped_column(String(12), unique=True, index=True)
    #: Кто привёл. Ставится ОДИН раз при создании и никогда не переписывается —
    #: то же правило, что у acquisition_source: первое касание есть первое
    #: касание, и второй заход по чужой ссылке его не присваивает.
    referred_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True,
    )
```

Убедиться, что `ForeignKey` импортирован из `sqlalchemy`.

В `backend/app/models/ad_touch.py` рядом со `slug`:

```python
    #: Что за метка: «ad» — рекламная кампания, «ref» — приглашение от
    #: пользователя. Разбор и приоритеты у них общие, различается только то,
    #: во что метка превращается при логине.
    kind: Mapped[str] = mapped_column(String(8), default="ad", server_default="ad")
```

В `backend/app/main.py`, в `_apply_demo_migrations`:

```python
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER",
        "ALTER TABLE ad_touches ADD COLUMN IF NOT EXISTS kind VARCHAR(8) NOT NULL DEFAULT 'ad'",
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_referral_code ON users (referral_code)",
```

В `backend/app/scripts/bot_polling.py`, в `REQUIRED_SCHEMA`:

```python
    "users": (
        "photo_url",
        "last_bot_message_id",
        "onboarding_seen_at",
        "acquisition_source",
        "referral_code",
        "referred_by_user_id",
    ),
    # Бот пишет сюда при /start, а мини-миграции выполняет API-контейнер: бот
    # может подняться раньше и упасть на колонке, которой ещё нет.
    "ad_touches": ("kind",),
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_referral.py tests/test_bot_tick.py tests/test_ad_attribution.py -v`
Ожидается: PASS. `test_ad_attribution.py` проверяется обязательно: мы трогаем
таблицу, которой он владеет.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/models/user.py backend/app/models/ad_touch.py backend/app/main.py backend/app/scripts/bot_polling.py backend/tests/test_referral.py
git commit -m "feat(рефералы): колонки связи и вид метки первого касания"
```

---

### Задача 11: разбор реферального payload

**Файлы:**
- Изменить: `backend/app/services/telegram_bot.py` (рядом с `parse_ad_payload`)
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Отдаёт: `parse_ref_payload(payload: str) -> str | None` — код без префикса
  или `None`; `REF_PAYLOAD_PREFIX = "ref_"`; `REF_CODE_LENGTH = 8`.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_parse_ref_payload():
    from app.services.telegram_bot import parse_ref_payload

    assert parse_ref_payload("ref_A1b2C3d4") == "A1b2C3d4"
    assert parse_ref_payload("ad_direct") is None
    assert parse_ref_payload("product_42") is None
    assert parse_ref_payload("ref_") is None
    # Юникод-символы приходят мимо реальной ссылки: Telegram в start отдаёт
    # только ASCII-буквы, цифры, дефис и подчёркивание.
    assert parse_ref_payload("ref_абвгдежз") is None
    # Длина фиксирована: чужая строка нужной формы кодом не является.
    assert parse_ref_payload("ref_A1b2C3d4e5") is None


def test_ref_payload_fits_telegram_limit():
    """Лимит Telegram на start-параметр — 64 символа. У рекламных ссылок он
    выбран под ноль; реферальные обязаны остаться далеко внутри."""
    from app.services.telegram_bot import REF_CODE_LENGTH, REF_PAYLOAD_PREFIX

    assert len(REF_PAYLOAD_PREFIX) + REF_CODE_LENGTH <= 64
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_referral.py::test_parse_ref_payload -v`
Ожидается: FAIL — `ImportError`.

- [ ] **Шаг 3: реализация**

В `backend/app/services/telegram_bot.py`, рядом с рекламным разбором:

```python
#: Реферальный payload: ref_<код>. Работает по обеим ссылкам так же, как
#: рекламный (см. AD_PAYLOAD_PREFIX), но ведём мы ТОЛЬКО в чат: вход по
#: ?startapp= не даёт боту права писать человеку, и приглашённый навсегда
#: остался бы без напоминаний о корзине и статусов заявки.
REF_PAYLOAD_PREFIX = "ref_"

#: Длина кода. Фиксирована, а не «до N»: строка чужого формата нужной длины
#: кодом не является, и проверка длины отсекает мусор до похода в базу.
REF_CODE_LENGTH = 8


def parse_ref_payload(payload: str) -> str | None:
    """«ref_A1b2C3d4» -> «A1b2C3d4»; всё остальное -> None.

    Allowlist перечислен явно, а не через isalnum(): последний пропускает
    юникод («ref_абвгдежз»), а Telegram в start-параметре отдаёт только эти
    символы — всё прочее приходит к нам мимо реальной ссылки.
    """
    if not payload or not payload.startswith(REF_PAYLOAD_PREFIX):
        return None
    code = payload[len(REF_PAYLOAD_PREFIX):]
    if len(code) != REF_CODE_LENGTH or not all(c in AD_SLUG_ALPHABET for c in code):
        return None
    return code
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_referral.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/telegram_bot.py backend/tests/test_referral.py
git commit -m "feat(рефералы): разбор payload реферальной ссылки"
```

---

### Задача 12: выдача личного кода

**Файлы:**
- Создать: `backend/app/services/referral.py`
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Потребляет: `REF_CODE_LENGTH`, `AD_SLUG_ALPHABET` (задача 11).
- Отдаёт: `referral.code_for(db, user) -> str` — выдаёт код, создавая его при
  первом обращении; `referral.user_by_code(db, code) -> User | None`.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_code_is_issued_once_and_is_stable(db):
    from app.services import referral

    user = User(telegram_id=901)
    db.add(user)
    db.commit()
    db.refresh(user)

    first = referral.code_for(db, user)
    assert len(first) == 8
    assert referral.code_for(db, user) == first, "код обязан быть постоянным"


def test_code_resolves_back_to_user(db):
    from app.services import referral

    user = User(telegram_id=902)
    db.add(user)
    db.commit()
    db.refresh(user)

    code = referral.code_for(db, user)
    assert referral.user_by_code(db, code).id == user.id
    assert referral.user_by_code(db, "zzzzzzzz") is None
    assert referral.user_by_code(db, "") is None
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_referral.py::test_code_is_issued_once_and_is_stable -v`
Ожидается: FAIL — модуля нет.

- [ ] **Шаг 3: реализация**

Создать `backend/app/services/referral.py`:

```python
"""Реферальная программа: код, связь, выплаты.

Правила живут ЗДЕСЬ, а не в loyalty.record(): record остаётся примитивом
журнала, который умеет провести операцию и больше ничего не знает. Благодаря
этому выплата не может вызвать сама себя — триггером служит только
kind='purchase', а сама выплата имеет kind='referral'.

Один уровень вверх и никаких цепочек: если A привёл B, а B привёл C, то с
покупки C получает только B. Многоуровневость — это пирамида.
"""
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.telegram_bot import AD_SLUG_ALPHABET, REF_CODE_LENGTH

_ALPHABET = "".join(sorted(AD_SLUG_ALPHABET))


def _new_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(REF_CODE_LENGTH))


def code_for(db: Session, user: User) -> str:
    """Код человека, создавая его при первом обращении.

    Коллизия ловится уникальным индексом и вызывает повторную генерацию, а не
    проверкой «сначала посмотрим»: последняя — гонка.
    """
    if user.referral_code:
        return user.referral_code
    for _ in range(5):
        candidate = _new_code()
        user.referral_code = candidate
        try:
            with db.begin_nested():
                db.flush()
        except Exception:
            user.referral_code = None
            continue
        db.commit()
        return candidate
    raise RuntimeError("Не удалось выдать реферальный код: пять коллизий подряд")


def user_by_code(db: Session, code: str) -> User | None:
    if not code:
        return None
    return db.execute(select(User).where(User.referral_code == code)).scalar_one_or_none()
```

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_referral.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/referral.py backend/tests/test_referral.py
git commit -m "feat(рефералы): выдача личного кода приглашения"
```

---

### Задача 13: захват связи при регистрации

**Файлы:**
- Изменить: `backend/app/api/auth.py` (`_get_or_create_user`),
  `backend/app/services/ad_touch.py` (учёт `kind`)
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Потребляет: `parse_ref_payload`, `referral.user_by_code`, `ad_touch.slug_for`.
- Отдаёт: у нового пользователя проставлены `referred_by_user_id` и
  `acquisition_source = "ref_<код>"`; пишется событие `referral_signup`.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_referral_link_binds_new_user(client, db):
    """Связь ставится при СОЗДАНИИ пользователя и пишется в источник тем же
    форматом, что рекламные метки, — чтобы фильтр админки работал без правок."""
    from app.services import referral

    inviter = User(telegram_id=910)
    db.add(inviter)
    db.commit()
    db.refresh(inviter)
    code = referral.code_for(db, inviter)

    invited = _login(client, telegram_id=911, start_param=f"ref_{code}")

    assert invited.referred_by_user_id == inviter.id
    assert invited.acquisition_source == f"ref_{code}"


def test_existing_user_is_not_rebound(client, db):
    """Повторный заход по чужой ссылке не имеет права присвоить себе человека —
    то же правило, что у рекламной метки."""
    from app.services import referral

    inviter = User(telegram_id=912)
    db.add(inviter)
    db.commit()
    db.refresh(inviter)
    code = referral.code_for(db, inviter)

    _login(client, telegram_id=913)
    again = _login(client, telegram_id=913, start_param=f"ref_{code}")
    assert again.referred_by_user_id is None


def test_self_referral_is_refused(client, db):
    """Дешёвая проверка, на которую нельзя полагаться «этого не может быть»:
    речь о деньгах."""
    from app.services import referral

    user = _login(client, telegram_id=914)
    code = referral.code_for(db, user)
    db.refresh(user)

    # Тот же telegram_id заходит снова по собственной ссылке.
    again = _login(client, telegram_id=914, start_param=f"ref_{code}")
    assert again.referred_by_user_id is None


def test_unknown_code_is_not_an_error(client, db):
    invited = _login(client, telegram_id=915, start_param="ref_zzzzzzzz")
    assert invited.referred_by_user_id is None
```

Вспомогательную функцию `_login(client, telegram_id, start_param=None)` написать
по образцу `backend/tests/test_ad_attribution.py` — там уже собран валидный
`init_data` и вызов `POST /api/auth/telegram`. Скопировать приём оттуда, а не
изобретать.

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_referral.py::test_referral_link_binds_new_user -v`
Ожидается: FAIL — `referred_by_user_id` остался `None`.

- [ ] **Шаг 3: реализация**

В `backend/app/api/auth.py`, в `_get_or_create_user`, **после** блока рекламной
метки и **до** `db.commit()`:

```python
    # Реферальная связь — та же логика, что у рекламной метки, и по тем же
    # причинам: только при создании, приоритет у start_param, иначе первое
    # касание в чате. Отличие одно: метка превращается не в строку источника, а
    # в связь между двумя пользователями, по которой годами идут выплаты.
    ref_code = parse_ref_payload(start_param) if (created and start_param) else None
    if created and ref_code is None:
        ref_code = ad_touch.slug_for(db, tg_user["id"], kind="ref")
    if ref_code is not None:
        inviter = referral.user_by_code(db, ref_code)
        # Самоприглашение отсекается явно. Новый пользователь своего кода ещё
        # не имеет, но полагаться на «этого не может случиться» в денежной
        # механике нельзя.
        if inviter is not None and inviter.id != user.id:
            user.referred_by_user_id = inviter.id
            user.acquisition_source = f"ref_{ref_code}"
        else:
            ref_code = None
```

После `db.commit()`, рядом с событием `ad_signup`:

```python
    if ref_code is not None:
        db.add(AnalyticsEvent(
            user_id=user.id, event="referral_signup",
            payload={"code": ref_code, "inviter_id": user.referred_by_user_id},
        ))
        db.commit()
```

Добавить импорты `parse_ref_payload` и `from app.services import referral`.

В `backend/app/services/ad_touch.py` научить `slug_for` и `remember` различать
вид, сохранив прежнее поведение по умолчанию:

```python
def slug_for(db, telegram_id: int, kind: str = "ad") -> str | None:
```

и добавить в запрос условие `AdTouch.kind == kind`. В `remember` — параметр
`kind: str = "ad"`, записываемый в строку. Обработчик `/start` в боте должен
вызывать `remember(..., kind="ref")` для реферального payload; найти место
вызова через `grep -n "remember" backend/app/services/telegram_bot.py`.

**Проверить обязательно:** событие `referral_signup` должно попасть в allowlist
аналитики, иначе оно будет отвергнуто. Найти список через
`grep -rn "ad_signup" backend/app` и добавить рядом; тест
`test_event_allowlist_sync.py` это проверяет.

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_referral.py tests/test_ad_attribution.py tests/test_event_allowlist_sync.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/api/auth.py backend/app/services/ad_touch.py backend/app/services/telegram_bot.py backend/tests/test_referral.py
git commit -m "feat(рефералы): захват связи «кто кого привёл» при регистрации"
```

---

# Фаза 5. Выплаты

### Задача 14: расчёт выплат — чистые функции

**Файлы:**
- Изменить: `backend/app/services/referral.py`
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Отдаёт:
  - `referral.payout_points(amount, rate_bps) -> int` — процент пригласившему;
  - `referral.is_first_purchase(db, user_id) -> bool`.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_payout_points_rounds_down():
    from app.services import referral

    assert referral.payout_points(100_000, 100) == 1000   # 1%
    assert referral.payout_points(100_000, 250) == 2500   # 2,5%
    # Округление ВНИЗ: вверх дарило бы по баллу на каждой операции, и на
    # длинной истории это заметные деньги. Тот же приём, что в points_for.
    assert referral.payout_points(999, 100) == 9
    # С покупки дешевле 100 рублей при ставке 1% платить нечего.
    assert referral.payout_points(99, 100) == 0
    assert referral.payout_points(100_000, 0) == 0
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_referral.py::test_payout_points_rounds_down -v`
Ожидается: FAIL — `AttributeError`.

- [ ] **Шаг 3: реализация**

В `referral.py`:

```python
from decimal import Decimal

from app.models.loyalty import LoyaltyTransaction


def payout_points(amount: float | Decimal, rate_bps: int) -> int:
    """Процент с покупки, округлённый ВНИЗ.

    Ровно тот же расчёт, что у кэшбека (loyalty.points_for), и по той же
    причине вниз: округление вверх дарило бы по баллу на каждой операции.
    """
    if amount is None or amount <= 0 or rate_bps <= 0:
        return 0
    return int(Decimal(str(amount)) * rate_bps // 10_000)


def is_first_purchase(db: Session, user_id: int) -> bool:
    """Первая покупка — ровно одна проведённая операция вида «покупка».

    Считается ПОСЛЕ проведения текущей, поэтому единица, а не ноль.
    """
    count = db.execute(
        select(func.count()).select_from(LoyaltyTransaction).where(
            LoyaltyTransaction.user_id == user_id,
            LoyaltyTransaction.kind == "purchase",
        )
    ).scalar_one()
    return count == 1
```

Добавить импорт `func` из `sqlalchemy`.

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_referral.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/referral.py backend/tests/test_referral.py
git commit -m "feat(рефералы): расчёт процента и признак первой покупки"
```

---

### Задача 15: проведение и откат выплат

**Файлы:**
- Изменить: `backend/app/services/referral.py`,
  `backend/app/services/purchase.py`
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Потребляет: `payout_points`, `is_first_purchase`, `settings.loyalty`,
  `purchase.purchase_key`.
- Отдаёт:
  - `referral.payout_for_lead(db, lead, actor) -> None`;
  - `referral.revert_for_lead(db, lead, actor) -> None`;
  - ключи `lead_<id>_<seq>_referral`, `lead_<id>_<seq>_welcome`.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_inviter_gets_percent_and_invited_gets_welcome(admin_client, db):
    from app.models.lead import Lead
    from app.services import loyalty, referral

    inviter = User(telegram_id=920)
    invited = User(telegram_id=921)
    db.add_all([inviter, invited])
    db.commit()
    db.refresh(inviter)
    db.refresh(invited)
    invited.referred_by_user_id = inviter.id
    db.commit()

    lead = Lead(status="confirmed", user_id=invited.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(f"/api/admin/leads/{lead.id}",
                       json={"status": "completed", "final_total": 100_000})

    assert loyalty.summary(db, inviter.id)["balance"] == 1000       # 1%
    # 250 собственного кэшбека «Старта» + 1000 приветственных
    assert loyalty.summary(db, invited.id)["balance"] == 1250
    # Реферальный доход не двигает оборот: уровень так не поднять.
    assert loyalty.summary(db, inviter.id)["lifetime_spent"] == 0


def test_second_purchase_pays_percent_but_not_welcome(admin_client, db):
    from app.models.lead import Lead
    from app.services import loyalty

    inviter = User(telegram_id=922)
    invited = User(telegram_id=923)
    db.add_all([inviter, invited])
    db.commit()
    db.refresh(inviter)
    db.refresh(invited)
    invited.referred_by_user_id = inviter.id
    db.commit()

    for _ in range(2):
        lead = Lead(status="confirmed", user_id=invited.id)
        db.add(lead)
        db.commit()
        db.refresh(lead)
        admin_client.patch(f"/api/admin/leads/{lead.id}",
                           json={"status": "completed", "final_total": 100_000})

    assert loyalty.summary(db, inviter.id)["balance"] == 2000       # 1% дважды
    # 250 + 250 кэшбека и ОДИН приветственный бонус
    assert loyalty.summary(db, invited.id)["balance"] == 1500


def test_zero_percent_creates_no_transaction(admin_client, db):
    """С покупки дешевле 100 рублей платить нечего, и это не ошибка:
    record() запрещает операции на ноль баллов."""
    from app.models.lead import Lead
    from app.services import loyalty

    inviter = User(telegram_id=924)
    invited = User(telegram_id=925)
    db.add_all([inviter, invited])
    db.commit()
    db.refresh(inviter)
    db.refresh(invited)
    invited.referred_by_user_id = inviter.id
    db.commit()

    lead = Lead(status="confirmed", user_id=invited.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    resp = admin_client.patch(f"/api/admin/leads/{lead.id}",
                              json={"status": "completed", "final_total": 50})
    assert resp.status_code == 200
    assert loyalty.summary(db, inviter.id)["balance"] == 0


def test_revert_takes_back_referral_payouts(admin_client, db):
    from app.models.lead import Lead
    from app.services import loyalty

    inviter = User(telegram_id=926)
    invited = User(telegram_id=927)
    db.add_all([inviter, invited])
    db.commit()
    db.refresh(inviter)
    db.refresh(invited)
    invited.referred_by_user_id = inviter.id
    db.commit()

    lead = Lead(status="confirmed", user_id=invited.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    admin_client.patch(f"/api/admin/leads/{lead.id}",
                       json={"status": "completed", "final_total": 100_000})
    admin_client.patch(f"/api/admin/leads/{lead.id}", json={"status": "cancelled"})

    assert loyalty.summary(db, inviter.id)["balance"] == 0
    assert loyalty.summary(db, invited.id)["balance"] == 0
```

- [ ] **Шаг 2: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_referral.py::test_inviter_gets_percent_and_invited_gets_welcome -v`
Ожидается: FAIL — баланс пригласившего 0.

- [ ] **Шаг 3: реализация**

В `referral.py`:

```python
def referral_key(lead_id: int, seq: int) -> str:
    return f"lead_{lead_id}_{seq}_referral"


def welcome_key(lead_id: int, seq: int) -> str:
    return f"lead_{lead_id}_{seq}_welcome"


def payout_for_lead(db: Session, lead, actor: str) -> None:
    """Выплаты по завершённой сделке приглашённого.

    Вызывается ПОСЛЕ проведения покупки: признак первой покупки считается по
    журналу, в котором она уже есть.
    """
    buyer = db.get(User, lead.user_id) if lead.user_id else None
    if buyer is None or buyer.referred_by_user_id is None:
        return

    conf = settings.loyalty(db)
    seq = lead.completion_seq or 0

    points = payout_points(lead.final_total, conf.referral_rate_bps)
    if points > 0:
        loyalty.record(
            db,
            user_id=buyer.referred_by_user_id,
            kind="referral",
            points=points,
            rate_bps=conf.referral_rate_bps,
            comment=f"{conf.referral_rate_bps / 100:g}% с покупки приглашённого (заявка {lead.id})",
            created_by=actor,
            idempotency_key=referral_key(lead.id, seq),
        )

    if conf.welcome_bonus_points > 0 and is_first_purchase(db, buyer.id):
        loyalty.record(
            db,
            user_id=buyer.id,
            kind="referral",
            points=conf.welcome_bonus_points,
            comment="Приветственные баллы за первую покупку по приглашению",
            created_by=actor,
            idempotency_key=welcome_key(lead.id, seq),
        )


def revert_for_lead(db: Session, lead, actor: str) -> None:
    """Отменить выплаты по заявке, вышедшей из статуса «завершена»."""
    seq = lead.completion_seq or 0
    for key in (referral_key(lead.id, seq), welcome_key(lead.id, seq)):
        original = loyalty.transaction_by_key(db, key)
        if original is None:
            continue
        loyalty.record(
            db,
            user_id=original.user_id,
            kind="correction",
            points=-original.points,
            comment=f"Заявка {lead.id} вышла из статуса «завершена»",
            created_by=actor,
            idempotency_key=f"{key}_revert",
        )
```

Добавить импорты `loyalty`, `settings`.

В `purchase.py`, в конец `accrue_for_lead`:

```python
    referral.payout_for_lead(db, lead, actor=actor)
```

и в конец `revert_for_lead`:

```python
    referral.revert_for_lead(db, lead, actor=actor)
```

**Важно:** в `purchase.revert_for_lead` ранний `return` при отсутствии
исходной покупки нужно убрать — реферальные выплаты откатываются независимо.
Переписать так, чтобы возврат кэшбека и вызов `referral.revert_for_lead`
выполнялись оба.

- [ ] **Шаг 4: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_referral.py tests/test_purchase_fact.py -v`
Ожидается: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/services/referral.py backend/app/services/purchase.py backend/tests/test_referral.py
git commit -m "feat(рефералы): выплата процента и приветственных баллов с откатом"
```

---

### Задача 16: уведомление пригласившему

**Файлы:**
- Изменить: `backend/app/services/referral.py`,
  `backend/app/services/notification_templates.py`
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Потребляет: `services/notifications.py` (создание уведомления с `dedupe_key`).

- [ ] **Шаг 1: прочитать образец**

Прочитать `_notify_status_change` в `backend/app/api/admin_crm.py:146` и
`docs/context/notifications.md`. Уведомление создаётся с `dedupe_key`, иначе
повторное сохранение статуса пошлёт человеку второе сообщение.

- [ ] **Шаг 2: написать падающий тест**

```python
def test_inviter_is_notified_once(admin_client, db):
    from app.models.lead import Lead
    from app.models.notification import Notification
    from sqlalchemy import select

    inviter = User(telegram_id=930)
    invited = User(telegram_id=931)
    db.add_all([inviter, invited])
    db.commit()
    db.refresh(inviter)
    db.refresh(invited)
    invited.referred_by_user_id = inviter.id
    db.commit()

    lead = Lead(status="confirmed", user_id=invited.id)
    db.add(lead)
    db.commit()
    db.refresh(lead)

    for _ in range(2):
        admin_client.patch(f"/api/admin/leads/{lead.id}",
                           json={"status": "completed", "final_total": 100_000})

    rows = db.execute(
        select(Notification).where(Notification.user_id == inviter.id)
    ).scalars().all()
    assert len(rows) == 1, "двойное сохранение не должно слать второе сообщение"
    assert "1000" in rows[0].text
```

- [ ] **Шаг 3: убедиться, что тест падает**

Запустить: `cd backend && python -m pytest tests/test_referral.py::test_inviter_is_notified_once -v`
Ожидается: FAIL — уведомлений нет.

- [ ] **Шаг 4: реализация**

В `notification_templates.py` добавить функцию, возвращающую текст:
«Ваш друг забрал покупку — вам начислено N баллов». Точное оформление взять по
образцу соседних шаблонов в том же файле.

В `referral.payout_for_lead`, сразу после успешного начисления процента,
создать уведомление с `dedupe_key=f"referral:{lead.id}:{seq}"` тем же способом,
что `_notify_status_change`.

Приглашённому отдельного сообщения не слать: он и так получает уведомление о
статусе заявки.

- [ ] **Шаг 5: убедиться, что тесты проходят**

Запустить: `cd backend && python -m pytest tests/test_referral.py -v`
Ожидается: PASS.

- [ ] **Шаг 6: коммит**

```bash
git add backend/app/services/referral.py backend/app/services/notification_templates.py backend/tests/test_referral.py
git commit -m "feat(рефералы): уведомление пригласившему о начислении"
```

---

# Фаза 6. Экраны

### Задача 17: API счёта приглашений и экран в профиле

**Файлы:**
- Создать: `backend/app/api/referral.py`, `frontend/src/lib/referral.ts`,
  `frontend/src/lib/referral.test.ts`
- Изменить: `backend/app/main.py`, `frontend/src/pages/Profile.tsx`
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Отдаёт: `GET /api/referral/me` →
  `{"code": str, "link": str, "invited_count": int, "earned_points": int,
    "rate_percent": float, "welcome_bonus_points": int}`.

- [ ] **Шаг 1: написать падающий тест API**

```python
def test_referral_me_returns_link_and_totals(client, db):
    """Условия отдаются вместе со счётом: экран обязан назвать их полностью и
    заранее — роудмап обещает «без условий, которые видно только в конце»."""
    ...  # авторизация по образцу существующих тестов /loyalty/me
```

Написать целиком по образцу теста `GET /loyalty/me` в
`backend/tests/test_loyalty.py` — там уже собрано переопределение
`get_current_user`.

- [ ] **Шаг 2: реализация API**

`backend/app/api/referral.py` — один маршрут. `code` берётся через
`referral.code_for` (создаётся при первом открытии экрана), `link` собирается
из `bot_username`, который уже отдаётся в `GET /api/config/public`.
`earned_points` — сумма `points` по операциям `kind='referral'` этого
пользователя, исключая приветственный бонус: он про приглашённого, а не про
приглашающего. Различать по `rate_bps IS NOT NULL`.

Зарегистрировать роутер в `main.py`.

- [ ] **Шаг 3: чистая логика фронта с тестом**

`frontend/src/lib/referral.ts` — типы ответа и функция построения текста
условий из чисел (`rate_percent`, `welcome_bonus_points`), чтобы текст не
разъезжался с настройками. Тест рядом в `referral.test.ts`.

- [ ] **Шаг 4: блок в профиле**

В `frontend/src/pages/Profile.tsx` рядом с блоком «Баллы» (строка ~119) —
карточка приглашений: ссылка, кнопка «Поделиться» через существующий
`lib/share.ts`, счётчики и **полный текст условий**. Тач-таргет ≥ 44×44
(`min-h-11`).

Делиться внутренним адресом Mini App нельзя — только deep link; `lib/share.ts`
это уже умеет и менять его не нужно.

- [ ] **Шаг 5: проверки и коммит**

```bash
cd backend && python -m pytest -q
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
```

```bash
git add backend/app/api/referral.py backend/app/main.py frontend/src/lib/referral.ts frontend/src/lib/referral.test.ts frontend/src/pages/Profile.tsx backend/tests/test_referral.py
git commit -m "feat(рефералы): экран приглашений в профиле"
```

---

### Задача 18: текст карточки в роудмапе

**Файлы:**
- Изменить: `frontend/src/lib/roadmap.ts:58-65`

**Почему отдельной задачей:** карточка `referral` обещает пользователям
**разовое** начисление за первую покупку друга. Механика теперь другая —
бессрочный процент. Если не переписать, приложение врёт с первого дня.

- [ ] **Шаг 1: заменить текст**

```ts
  {
    id: "referral",
    title: "Приглашайте друзей",
    body:
      "Личная ссылка в профиле: друг получает баллы за первую покупку, а вам " +
      "идёт процент с каждой его покупки — без срока и без условий, которые " +
      "видно только в конце.",
    period: "sep",
    tracks: ["app", "loyalty"],
  },
```

Числа в текст не зашивать: они настраиваются в админке, и текст с «1%»
разъедется с настройкой молча. Точные значения человек видит на экране
приглашений, где они приходят с сервера.

- [ ] **Шаг 2: проверки**

```bash
cd frontend && npx tsc --noEmit && npx vitest run
```

Если есть тест, проверяющий состав роудмапа, — он должен остаться зелёным.

- [ ] **Шаг 3: коммит**

```bash
git add frontend/src/lib/roadmap.ts
git commit -m "fix(роудмап): текст про приглашения описывает настоящую механику"
```

---

### Задача 19: «кто кого привёл» в админке

**Файлы:**
- Изменить: `backend/app/api/admin_settings.py` (или создать
  `backend/app/api/admin_referrals.py`)
- Создать: `admin/src/Referrals.tsx`
- Изменить: `admin/src/App.tsx`
- Тест: `backend/tests/test_referral.py`

**Интерфейсы:**
- Отдаёт: `GET /api/admin/referrals` → список
  `{"inviter": {...}, "invited": {...}, "registered_at": str,
    "completed_leads": int, "paid_points": int}`, отсортированный по
  `paid_points` убыванию.

**Почему сортировка по сумме выплат:** накрутка всплывает наверх сама, без
отдельного детектора.

- [ ] **Шаг 1: написать падающий тест**

```python
def test_admin_sees_referral_pairs_sorted_by_payout(admin_client, db):
    """Сортировка по сумме выплат: накрутка всплывает наверх сама."""
    ...  # две пары с разными выплатами, проверить порядок
```

Написать целиком, заведя две пары «пригласивший — приглашённый» с разными
суммами завершённых сделок и проверив, что первым идёт тот, кому заплатили
больше.

- [ ] **Шаг 2: реализация API**

Один запрос с агрегатами, а не запрос на строку: список считается целиком —
тот же приём, что `loyalty.totals` и `apply_social_proof`.

- [ ] **Шаг 3: экран**

`admin/src/Referrals.tsx` по образцу `admin/src/Customers.tsx`: таблица с
колонками «Пригласивший», «Приглашённый», «Регистрация», «Завершённых сделок»,
«Выплачено баллов». Вкладка регистрируется в `admin/src/App.tsx` рядом с
«Клиенты».

- [ ] **Шаг 4: проверки**

```bash
cd backend && python -m pytest -q
cd admin && npx tsc --noEmit && npm run build
```

- [ ] **Шаг 5: коммит**

```bash
git add backend/app/api backend/app/main.py admin/src/Referrals.tsx admin/src/App.tsx backend/tests/test_referral.py
git commit -m "feat(админка): раздел «кто кого привёл» с суммами выплат"
```

---

# Финал: документация и выкатка

### Задача 20: обновить контекст проекта

**Файлы:**
- Изменить: `docs/context/cart-and-loyalty.md`, `docs/context/releases.md`,
  `CLAUDE.md` (одна строка-указатель)

- [ ] **Шаг 1: починить утверждение, ставшее ложью**

В `docs/context/cart-and-loyalty.md` фраза «Начисление только вручную из
админки. Автоматики на статусе заявки нет намеренно» после этой работы —
неправда. Заменить на описание нового правила: автоматика есть, но её основание
— терминальный статус ВМЕСТЕ с подтверждённой итоговой суммой; ни один другой
статус баллов не даёт; оценочный `estimated_total` не используется нигде.

- [ ] **Шаг 2: описать реферальную программу**

Добавить раздел про `services/referral.py`, ключи идемпотентности с номером
попытки, послабление минуса для корректировок и границы защиты (§5.3 спеки —
менеджер остаётся последним рубежом).

- [ ] **Шаг 3: запись в releases.md**

Добавить запись о выпуске. **Обязательно указать, проверено ли на живом
устройстве** — умолчание об этом будет такой же ложью, как исправляемая выше.

- [ ] **Шаг 4: строка в CLAUDE.md**

В таблицу «Куда идти по теме» добавить строку про рефералы и факт покупки со
ссылкой на `docs/context/cart-and-loyalty.md`. Одна строка, не больше — файл
читается в начале каждой сессии и стоит токенов.

- [ ] **Шаг 5: коммит**

```bash
git add docs/context CLAUDE.md
git commit -m "docs(контекст): факт покупки и реферальная программа"
```

---

### Задача 21: выкатка

- [ ] **Шаг 1: полный прогон проверок**

```bash
cd backend && python -m pytest -q
cd frontend && npx tsc --noEmit && npx vitest run && npm run build
cd admin && npx tsc --noEmit && npm run build
```

Все три обязаны быть зелёными. Не «почти».

- [ ] **Шаг 2: убедиться, что дерево чистое**

```bash
git status --short
```

Деплой синхронизирует ВСЁ рабочее дерево, включая незакоммиченное.

- [ ] **Шаг 3: деплой**

**Только из Git Bash:**

```bash
bash update-server.sh
```

Из PowerShell — явным путём: `& "C:\Program Files\Git\bin\bash.exe" update-server.sh`.

- [ ] **Шаг 4: проверить, что бот пережил миграцию**

Это главный риск выкатки: три новые колонки в таблицах, которые читает бот.

```bash
ssh iseller "docker logs --tail 50 techshop-bot-1 2>&1 | grep -i 'undefinedcolumn\|traceback' || echo 'бот чист'"
ssh iseller "docker ps --format '{{.Names}}: {{.Status}}'"
```

Ожидается: «бот чист» и все контейнеры `Up`.

- [ ] **Шаг 5: проверить прод снаружи**

```bash
curl -s -o /dev/null -w "api: %{http_code}\n" https://158.255.1.248.sslip.io/api/health
```

Ожидается: 200.

- [ ] **Шаг 6: проверка на живом устройстве**

Тесты не ловят этот класс дефектов. Пройти руками с телефона:

1. открыть профиль, увидеть блок приглашений и полный текст условий;
2. нажать «Поделиться» — ссылка должна быть `t.me/<bot>?start=ref_…`, а не
   внутренний адрес Mini App;
3. открыть эту ссылку со ВТОРОГО аккаунта, войти, проверить в админке, что
   связь появилась;
4. завершить заявку второго аккаунта с итоговой суммой, проверить начисления у
   обоих;
5. отменить заявку, проверить, что баллы вернулись.

---

# Самопроверка плана

**Покрытие спеки.** Часть 1 (факт покупки) — задачи 3–6; часть 2 (связь) —
10–13; часть 3 (выплаты) — 14–16; часть 4 (настройки) — 7–9; часть 5
(наблюдаемость) — 19; раздел 6 (что видит пользователь) — 17; долг по роудмапу
— 18; правка `record()` из §1.3 и §3.3 — задачи 1 и 2; документация — 20.
Непокрытых требований спеки нет.

**Порядок.** Фазы 1–2 самодостаточны: автоматический кэшбек полезен сам по
себе и может уехать без остальных. Фаза 3 идёт раньше выплат, чтобы рубильник
существовал до того, как появится что выключать.

**Согласованность имён.** `purchase_key`/`referral_key`/`welcome_key` —
единый формат `lead_<id>_<seq>_<вид>`, ключ отката везде `<ключ>_revert`.
`accrue_for_lead`/`revert_for_lead` — одинаковые имена в `purchase` и
`referral`, вызываются парами. `payout_points` и `loyalty.points_for` считают
по одной формуле с округлением вниз.

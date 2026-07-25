# Photo Coverage Workspace + Rocketniks Matcher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an in-admin "Photo Coverage" workspace and a read-only Rocketniks **Public API**
matcher so an admin can find, review, confirm, and apply up to 10 photos per product to
iSeller's own storage — no hotlinking, no auto-import, no price/stock import.

**Architecture:** Backend gains a cached Rocketniks Public-API client, a deterministic matcher
(scoring + conflict rules), and confirm→download→validate→apply endpoints that reuse the existing
`uploads`/`image_groups`/`AuditLog` stack. Admin gains an expanded Media → "Покрытие фотографиями"
workspace with match preview/apply side panel. Everything is admin-only, additive, and reversible
(last batch rollback).

**Tech Stack:** FastAPI + SQLAlchemy (backend), React/Vite + TS (admin), Pillow (image validation),
httpx (API client), pytest / vitest.

---

## Part 0 — Audit of v5.4.0 (DONE, reuse targets)

| Concern | Location | Reuse |
| --- | --- | --- |
| MAX_PRODUCT_IMAGES = 10 | `backend/app/core/uploads.py:20` | limit constant |
| upload service | `uploads.py` | `save_image(ct,data)→url`, `delete_image(url)`, `is_allowed`, `MAX_BYTES`, `_EXT`, `normalize_gallery(urls,main,limit)→(images,excess)` |
| gallery invariants | `admin_crm.py:597` | main=images[0], no dups, ≤10, placeholder-aware |
| image endpoints | `admin_crm.py` `/products/{id}/images{,/bulk,/main,/reorder}` + DELETE | apply/reorder patterns (⚠ currently **no** audit log) |
| image groups | `services/image_groups.py` | `image_group_key=brand\|model\|color`, `resolve_product_images` (batch, no N+1), `apply_group_images`, `dedupe_by_group`; model `product_image_group.py` |
| photo-coverage | `admin_crm.py:369` `/admin/photo-coverage` | summary + priority + filters + pagination; placeholder≠photo |
| audit log | `models/audit.py`, pattern `admin_crm.py:502,567` | `AuditLog(actor=f"admin:{admin}",action,ip=client_ip(request),detail=json.dumps(...))` |
| admin Media tab | `admin/src/HomeAdmin.tsx` `PhotoCoverage` (651), ZIP import (624); tab in `App.tsx` `{key:"media"}` | extend, don't replace |
| Products photo editor | `admin/src/Products.tsx:426` (upload/reorder/main/delete) + "Группа фото" (600) | link "открыть товар" |
| CSV reports / audit script | `scripts/photo_coverage_audit.py`, `docs/photo-research/2026-07-24/` | export format parity |

Router `admin_crm.py` has `dependencies=[Depends(get_current_admin)]` → **all** new endpoints
added there are admin-gated by construction (Part 7 "permissions" satisfied).

## Rocketniks Public API contract (discovered, read-only)

- Base `http://api.rocketniks.ru`; header `X-Api-Key: <key>` (key read from ENV
  `ROCKETNIKS_API_KEY`, never hardcoded in source, never committed, never logged).
- `GET /api/categories` → tree `[{categoryInfo{externalId,name,url,image},children[]}]`.
- `GET /api/products?CategoryUrl=<slug>&page=N` → `{pageIndex,pageSize,totalPages,totalItems,hasNextPage,items[{externalId,name,vendorCode,price,oldPrice,quantity,inStock,image,url,category}]}` (50/page).
- `GET /api/search?query=<text>` → `{products[{name,vendorCode,image,url}] (≤20), brands[], categories[]}`; exact `vendorCode` query → 1 hit.
- `GET /api/products/{url-slug}` → detail `{externalId,name,description,shortDescription,meta,vendorCode,price,oldPrice,inStock,image,color{name,code},brand{name,url},category{name,url},variantsLinks{colors,links},images[gallery ≤10 {url,size,sizes{large,medium,small}}],vartiantImages,propertiesGroups[{groupName,properties[{name,value}]}],breadcrumbs,tags}`.
- Image URL: relative `/images/products/<file>.(jpg|png|webp)`; absolute = base+path; `sizes.large` = biggest. Brand/category logos live under `/images/brands|categories/` → **excluded** as non-product.
- robots.txt: none on API host (404). Site host disallows `/*?`; API is the sanctioned machine interface. Client still uses gentle delay + on-disk cache + resume. No CAPTCHA/auth bypass anywhere.

**Matching signals:** `vendorCode`↔our SKU (exact article 50); `brand.name`; normalized model/gen (25);
`color.name`/`code` (15); size from `propertiesGroups` dims (5); significant config (5).
Conflict on generation/size/color/physical → auto-match forbidden (cap at `review`).

---

## File Structure

**Backend (new):**
- `backend/app/services/rocketniks_client.py` — cached httpx client (categories/products/search/detail), rate-limit, resume, error log. No image download here.
- `backend/app/services/rocketniks_matcher.py` — normalize + score + conflict + status; pure functions (testable without network).
- `backend/app/services/photo_apply.py` — download→validate→dedupe→save→apply→audit; last-batch rollback.
- `backend/app/models/photo_match.py` — `RocketniksMatch` (product_id, candidate url/vendorCode/name, score, status, tokens, retrieved_at) + `PhotoApplyBatch` (rollback ledger).
- `backend/app/api/photo_coverage.py` — admin endpoints (search/match/preview/apply/apply-group/rollback/export). Mounted under existing admin prefix.

**Backend (modified):**
- `backend/app/core/config.py` (or settings) — `ROCKETNIKS_API_KEY`, `ROCKETNIKS_BASE_URL`, `ROCKETNIKS_MIN_INTERVAL_MS`, `ROCKETNIKS_CACHE_DIR`, `ROCKETNIKS_ENABLED`.
- `backend/app/main.py` — include new router; `_apply_demo_migrations` create tables.
- `backend/app/api/admin_crm.py` — extend `/photo-coverage` item fields (main image, effective count, last-modified, matched?) + new filter buckets.

**Admin (modified):**
- `admin/src/PhotoCoverage.tsx` (extract from HomeAdmin) — full workspace: filter chips, search, table, row actions.
- `admin/src/RocketniksMatchPanel.tsx` — side panel (left iSeller / right candidate), apply actions.
- `admin/src/HomeAdmin.tsx` — render new workspace in Media tab.
- `admin/src/ui.ts` — API helpers if needed.

**Tests:** `backend/tests/test_rocketniks_matcher.py`, `test_photo_apply.py`, `test_photo_coverage_api.py`; `admin` vitest for panel logic; fixtures with recorded API JSON (no live calls in tests).

**Docs:** `docs/PHOTO_COVERAGE_ROCKETNIKS.md` (operator guide); `docs/plans/…` (this file).

---

## Phased Tasks (TDD, frequent commits)

### Phase A — Rocketniks API client + cache (backend, offline-testable)
- Config keys; `rocketniks_client.py` with injectable transport so tests use recorded JSON fixtures.
- Cache to `ROCKETNIKS_CACHE_DIR` (key = URL hash), resume-safe; min-interval throttle; structured error log; never logs the API key.
- Tests: cache hit avoids second call; throttle respected; 4xx/5xx surfaced not raised into 500.

### Phase B — Matcher (pure, deterministic)
- `normalize` reuse of `image_groups` helpers for model/color; extract vendorCode/size/config tokens.
- `score_candidate(product, candidate_detail)` → `{score, matched[], missing[], conflicts[], status}` with the 50/25/15/5/5 weights and conflict→cap-at-review rule.
- Status map: exact ≥90 & no conflict; likely 75–89; review 60–74; rejected <60 or conflict-with-high-model; not_found (no candidates).
- Tests (Part 7): exact vendorCode; generation conflict (iPhone 14 vs 15); color conflict; size conflict (41 vs 45 mm, Air13 vs Air15); AirPods ANC vs non-ANC; MacBook M4 vs M5 (visually identical → not a conflict); Dyson attachment/config difference.

### Phase C — Coverage workspace API + fields
- Extend `/admin/photo-coverage` items: `image` (effective main), `current_images`, `image_group_key`, `updated_at`, `match` summary (status+score if any), plus filter buckets: all/no_photo/placeholder/one/two_three/four_plus/broken/needs_review/ready; search by sku|title|model|color|vendorCode.
- `GET /admin/photo-coverage/{id}/rocketniks` → run matcher (cached) → candidates with scores/explanations. No download.
- Tests: bucket counts; search; matched-flag; broken detection is opt-in (HEAD check, throttled) not on list load.

### Phase D — Confirm → download → validate → apply (+ rollback)
- `photo_apply.py`: for confirmed candidate, download chosen image URLs (large variant) → validate HTTP 200 / MIME / signature (Pillow) / min resolution / SHA-256 / dedupe (within request + against product) / reject logos-thumbs-service; `save_image`; assemble ≤10 via `normalize_gallery`; set `Product.image=images[0]`, `Product.images`; write `AuditLog` (actor, source url, image URLs, sha list, count); record `PhotoApplyBatch` for rollback.
- `POST /admin/photo-coverage/{id}/apply` (selected or all≤10, to this SKU).
- `POST /admin/photo-coverage/group/apply` — show affected SKU list first; apply to confirmed **visual group** only after explicit `confirm:true`.
- `POST /admin/photo-coverage/rollback` — revert last batch (restore prior image/images; delete newly-saved files not referenced elsewhere).
- Tests (Part 7): limit 10; duplicate SHA rejection; download validation (bad MIME/signature/too-small); apply-one; apply-group with confirm gate; rollback restores prior gallery; existing non-placeholder gallery not overwritten without `overwrite:true`; no external URL ever stored (all become `/api/uploads/...`).

### Phase E — Admin UI
- Extract & expand `PhotoCoverage.tsx`; add row actions (open / manual upload / find on Rocketniks / view candidate / confirm / reject / apply / apply-to-group).
- `RocketniksMatchPanel.tsx`: left product gallery+SKU+specs, right candidate card (source URL, vendorCode, parsed params, image previews, score, explanation), apply buttons; group-apply shows affected SKUs + confirm.
- Read-only decisions fallback: statuses/notes persisted in `RocketniksMatch`; panel may be review-first if interactive apply proves heavy.
- Tests: vitest for panel state (select images, ≤10 guard, group-confirm), build.

### Phase F — Export
- `GET /admin/photo-coverage/export?kind=no_photos|needs_review|ready|rocketniks_matches` → CSV; plus `photo_coverage_report.md`. Parity with `scripts/photo_coverage_audit.py` columns.

### Phase G — Pilot (5 no-photo products) & verification
- Backend `pytest`, admin/frontend build + vitest, `docker compose config`, `git diff --check`.
- Pilot: pick 5 active products with 0 real photos → run matcher (cached) → show 5 groups, candidates found, exact/likely/review/rejected counts, photos available, one sample apply into a **scratch/test** product (not prod), list of issues.
- **No** full run, **no** deploy/push/merge/tag.

---

## Safety invariants (Part 6, enforced in code + tests)
- Admin-only (router dependency). No price/stock import (matcher ignores `price`/`oldPrice`/`quantity`/`inStock` for writes).
- No hotlink: images always downloaded and stored as `/api/uploads/...`; external URLs never written to `Product.image(s)`.
- No auto-import: apply requires explicit admin action even for `exact`.
- No overwrite of existing quality gallery without explicit `overwrite:true`.
- Every bulk/group/apply/rollback writes `AuditLog`; API key read from ENV, never logged.
- Reversible: `PhotoApplyBatch` enables last-batch rollback.

## Final question to user
"Раздел покрытия и пилот Rocketniks готовы. Проверяем и деплоим?"

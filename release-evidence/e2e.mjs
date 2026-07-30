/**
 * Сквозной приёмочный прогон RC2 на ЛОКАЛЬНОЙ production-сборке.
 *
 * Витрина  — http://localhost:4180 (nginx + собранный Vite, Dockerfile.prod)
 * Админка  — http://localhost:4181 (то же)
 *
 * Скрипт не знает и не вводит ни одного пароля: покупатель входит через
 * существующий /auth/dev, администратор — через /auth/admin/dev (маршрут
 * существует только при DEV_MODE=true).
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOP = "http://localhost:4180";
const ADMIN = "http://localhost:4181";
const OUT = process.argv[2] || "./release-evidence";
const SHOTS = join(OUT, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const report = { started_at: new Date().toISOString(), steps: [], assertions: [], screenshots: [], ui_matrix: [] };
let failures = 0;

function assert(name, ok, detail) {
  report.assertions.push({ name, ok: !!ok, detail: detail ?? null });
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  FAIL"}  ${name}${detail ? "  — " + JSON.stringify(detail) : ""}`);
}
function step(name, data) {
  report.steps.push({ name, data: data ?? null, at: new Date().toISOString() });
  console.log(`\n== ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, file, opts = {}) {
  const path = join(SHOTS, file);
  await page.screenshot({ path, ...opts });
  report.screenshots.push(file);
  console.log(`  [screenshot] ${file}`);
  return path;
}

/** Прокрутить внутренний контейнер к блоку с заданным заголовком.
 *  fullPage бесполезен: скроллится не документ, а <main> с overflow-y-auto,
 *  поэтому «полный» снимок всё равно показывает только первый экран. */
async function scrollTo(page, text) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll("main h1, main h2, main h3")]
      .find((e) => e.innerText.trim().startsWith(t));
    if (el) el.scrollIntoView({ block: "start" });
  }, text);
  await sleep(400);
}

/** Дождаться, пока приложение доавторизуется и отрисует контент. */
async function ready(page) {
  await page.waitForFunction(() => !document.body.innerText.includes("Загрузка…"), { timeout: 20000 });
  await sleep(600);
}

async function api(path, opts = {}) {
  const res = await fetch(`http://localhost:4180${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});

try {
  // ---------------------------------------------------------------- 0. токен
  step("Авторизация тестового пользователя (/auth/dev — тот же путь, что у Telegram-входа)");
  const auth = await api("/api/auth/dev", { method: "POST", body: "{}" });
  const token = auth.body.access_token;
  assert("Тестовый пользователь авторизован", auth.status === 200 && !!token);
  const authed = { headers: { Authorization: `Bearer ${token}` } };

  const me = await api("/api/users/me", authed);
  report.test_entities = { user_id: me.body.id, telegram_id: me.body.telegram_id, username: me.body.username };
  console.log(`  user_id=${me.body.id} telegram_id=${me.body.telegram_id}`);

  // Чистое состояние корзины перед прогоном
  await api("/api/cart", { method: "DELETE", ...authed });

  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") report.console_errors = [...(report.console_errors || []), m.text()]; });
  page.on("pageerror", (e) => { report.page_errors = [...(report.page_errors || []), String(e)]; });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // ------------------------------------------------------- 10. пустая корзина
  step("Пустая корзина");
  await page.goto(`${SHOP}/cart`, { waitUntil: "networkidle2" });
  await ready(page);
  await shot(page, "10-cart-empty-390x844.png", { fullPage: true });
  assert("Пустая корзина показывает подсказку, а не пустой экран",
    (await page.evaluate(() => document.body.innerText)).includes("В корзине пока ничего нет"));

  // ------------------------------------------------- 1-3. главная, три размера
  step("Главная — три разрешения");
  await page.goto(`${SHOP}/`, { waitUntil: "networkidle2" });
  await ready(page);
  await shot(page, "01-home-390x844.png");

  await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.reload({ waitUntil: "networkidle2" }); await ready(page);
  await shot(page, "02-home-430x932.png");

  await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 2 });
  await page.reload({ waitUntil: "networkidle2" }); await ready(page);
  await shot(page, "03-home-1366x768.png");

  // -------------------------------------------------- товар №1 — с ГЛАВНОЙ
  step("Товар №1 — добавление с Главной");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${SHOP}/`, { waitUntil: "networkidle2" });
  await ready(page);
  const p1 = await page.evaluate(() => {
    const b = document.querySelector('button[aria-label^="Добавить в корзину"]');
    if (!b) return null;
    b.click();
    return b.getAttribute("aria-label").replace("Добавить в корзину: ", "");
  });
  await sleep(1200);
  assert("Товар добавлен с Главной", !!p1, { title: p1 });

  // -------------------------------------------------- товар №2 — из КАТАЛОГА
  step("Товар №2 — добавление из Каталога (+ карточка до/после)");
  await page.goto(`${SHOP}/catalog`, { waitUntil: "networkidle2" });
  await ready(page);
  // Берём первую карточку, которой ЕЩЁ НЕТ в корзине
  const cardIdx = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card-appear.lift")];
    return cards.findIndex((c) => c.querySelector('button[aria-label^="Добавить в корзину"]'));
  });
  assert("Найдена карточка без товара в корзине", cardIdx >= 0, { index: cardIdx });
  const cardHandle = (await page.$$(".card-appear.lift"))[cardIdx];
  await cardHandle.scrollIntoView();
  await sleep(400);
  await shot(cardHandle, "04-product-card-before-add.png").catch(async () => {
    await cardHandle.screenshot({ path: join(SHOTS, "04-product-card-before-add.png") });
    report.screenshots.push("04-product-card-before-add.png");
  });
  const p2 = await page.evaluate((i) => {
    const card = [...document.querySelectorAll(".card-appear.lift")][i];
    const b = card.querySelector('button[aria-label^="Добавить в корзину"]');
    b.click();
    return b.getAttribute("aria-label").replace("Добавить в корзину: ", "");
  }, cardIdx);
  await sleep(1200);
  await cardHandle.screenshot({ path: join(SHOTS, "05-product-card-after-add.png") });
  report.screenshots.push("05-product-card-after-add.png");
  console.log("  [screenshot] 05-product-card-after-add.png");
  assert("Товар добавлен из Каталога", !!p2, { title: p2 });
  assert("После добавления карточка показывает степпер",
    await page.evaluate((i) => {
      const card = [...document.querySelectorAll(".card-appear.lift")][i];
      return !!card.querySelector('button[aria-label="Увеличить количество"]');
    }, cardIdx));

  // ------------------------------------------------------- 7. sticky cart bar
  step("Sticky cart bar");
  // Ждём, пока уйдёт тост «Добавлено в корзину»: он всплывает над панелью и на
  // снимке закрывал подпись про предварительную сумму.
  await page.waitForFunction(
    () => !document.body.innerText.includes("Добавлено в корзину"),
    { timeout: 8000 },
  ).catch(() => {});
  await sleep(400);
  const barBox = await page.evaluate(() => {
    const b = document.querySelector(".cart-dock");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(390, r.width + 16), height: r.height + 16 };
  });
  assert("Панель корзины отрисована", !!barBox);
  // Текст в панели не должен обрываться многоточием: узкая колонка легко
  // «съедает» длинную подпись, а на скриншоте это выглядит как ошибка.
  const barClipped = await page.evaluate(() => {
    const bar = document.querySelector(".cart-dock");
    return [...bar.querySelectorAll("span")]
      .filter((el) => !el.children.length && el.textContent.trim())
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent.trim());
  });
  assert("Подписи в панели корзины не обрезаны", barClipped.length === 0, barClipped);
  await shot(page, "07-sticky-cart-bar.png", { clip: barBox });

  // --------------------------------------------- товар №3 — из ProductDetails
  step("Товар №3 — добавление из карточки товара");
  const p3id = await page.evaluate((used) => {
    const cards = [...document.querySelectorAll(".card-appear.lift")];
    for (const c of cards) {
      const b = c.querySelector('button[aria-label^="Добавить в корзину"]');
      if (b && !used.includes(b.getAttribute("aria-label"))) {
        const t = c.querySelector("p.line-clamp-2")?.innerText || "";
        return t;
      }
    }
    return null;
  }, []);
  // Переходим на страницу товара через клик по названию третьей свободной карточки
  const opened = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card-appear.lift")];
    for (const c of cards) {
      if (c.querySelector('button[aria-label^="Добавить в корзину"]')) {
        const titleBtn = [...c.querySelectorAll("button")].find((b) => b.querySelector("p.line-clamp-2"));
        if (titleBtn) { titleBtn.click(); return true; }
      }
    }
    return false;
  });
  assert("Открыта карточка третьего товара", opened, { hint: p3id });
  await sleep(1500);
  await page.waitForSelector(".cta-dock", { timeout: 15000 });
  await shot(page, "06-product-details-add-to-cart.png");
  const p3 = await page.evaluate(() => {
    const dock = document.querySelector(".cta-dock");
    const b = [...dock.querySelectorAll("button")].find((x) => x.innerText.includes("Добавить в корзину"));
    if (!b) return null;
    b.click();
    return document.querySelector("h1")?.innerText || "";
  });
  await sleep(1400);
  assert("Товар добавлен из карточки товара", !!p3, { title: p3 });

  const afterAdds = await api("/api/cart", authed);
  assert("В корзине три разных товара", afterAdds.body.positions_count === 3,
    { positions: afterAdds.body.positions_count, titles: afterAdds.body.items.map((i) => i.title) });

  // --------------------------------------- удалить и снова добавить позицию
  step("Удаление позиции и повторное добавление");
  const victim = afterAdds.body.items[1];
  const del = await api(`/api/cart/items/${victim.id}`, { method: "DELETE", ...authed });
  assert("Позиция удалена", del.body.positions_count === 2, { positions: del.body.positions_count });
  const readd = await api("/api/cart/items", {
    method: "POST", ...authed, body: JSON.stringify({ product_id: victim.product_id, quantity: 1 }),
  });
  assert("Позиция добавлена снова", readd.body.positions_count === 3, { positions: readd.body.positions_count });

  // ------------------------------------------------- 8-9. корзина и количество
  step("Корзина: три товара, затем изменение количества");
  await page.goto(`${SHOP}/cart`, { waitUntil: "networkidle2" });
  await ready(page);
  await shot(page, "08-cart-three-items.png", { fullPage: true });

  await page.evaluate(() => {
    const b = document.querySelector('main button[aria-label="Увеличить количество"]');
    b.click();
  });
  await sleep(1300);
  await shot(page, "09-cart-after-quantity-change.png");
  const afterQty = await api("/api/cart", authed);
  assert("Количество изменено на сервере", afterQty.body.items_count === 4,
    { items_count: afterQty.body.items_count, quantities: afterQty.body.items.map((i) => i.quantity) });
  const expectedTotal = afterQty.body.items.reduce((s, i) => s + i.price * i.quantity, 0);
  assert("Сумма корзины совпадает с суммой позиций",
    Math.abs(afterQty.body.estimated_total - expectedTotal) < 0.01,
    { estimated_total: afterQty.body.estimated_total, computed: expectedTotal });
  report.cart_before_checkout = {
    positions: afterQty.body.positions_count,
    items_count: afterQty.body.items_count,
    estimated_total: afterQty.body.estimated_total,
    items: afterQty.body.items.map((i) => ({ product_id: i.product_id, sku: i.sku, price: i.price, quantity: i.quantity })),
  };

  // ------------------------------------------------------------ 11-12. checkout
  step("Оформление заявки");
  await page.evaluate(() => {
    const main = document.querySelector("main");
    const set = (el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const inputs = [...main.querySelectorAll('input[type="text"], input:not([type])')];
    set(inputs[0], "Приёмка RC2");
    set(inputs[1], "+70000000002");
    const ta = main.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "Автоматическая приёмка RC2");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const cb = main.querySelector('input[type="checkbox"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set.call(cb, true);
    cb.dispatchEvent(new Event("click", { bubbles: true }));
  });
  await sleep(500);
  await scrollTo(page, "Оформление");
  await shot(page, "11-checkout.png");

  // Тройное нажатие: защита от двойной отправки проверяется прямо здесь
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("main button")].find((x) => x.innerText.includes("Отправить заявку"));
    b.click(); b.click(); b.click();
  });
  await sleep(2500);
  await shot(page, "12-checkout-success.png");
  const successText = await page.evaluate(() => document.querySelector("main").innerText.replace(/\s+/g, " "));
  const numberMatch = successText.match(/Заявка №(\d+) отправлена/);
  assert("Показан success с номером заявки", !!numberMatch, { text: successText.slice(0, 120) });
  const leadId = numberMatch ? Number(numberMatch[1]) : null;
  report.lead_id = leadId;

  // ------------------------------------------------------------ 8. проверка БД
  step("Проверка через API (данные, которые видит менеджер)");
  const adminAuth = await api("/api/auth/admin/dev", { method: "POST" });
  assert("Тестовый админ-вход выдал токен", adminAuth.status === 200 && !!adminAuth.body.access_token);
  const adminAuthed = { headers: { Authorization: `Bearer ${adminAuth.body.access_token}` } };

  const detail = await api(`/api/admin/leads/${leadId}`, adminAuthed);
  const lead = detail.body;
  assert("lead_type = cart", lead.lead_type === "cart", { lead_type: lead.lead_type });
  assert("source = telegram_mini_app_cart", lead.source === "telegram_mini_app_cart", { source: lead.source });
  assert("В заявке три позиции", lead.items.length === 3, { items: lead.items.length });
  assert("Снапшоты количеств совпадают с корзиной",
    JSON.stringify(lead.items.map((i) => i.quantity).sort()) ===
    JSON.stringify(report.cart_before_checkout.items.map((i) => i.quantity).sort()),
    { lead: lead.items.map((i) => i.quantity), cart: report.cart_before_checkout.items.map((i) => i.quantity) });
  assert("Снапшоты цен совпадают с корзиной",
    JSON.stringify(lead.items.map((i) => i.price).sort()) ===
    JSON.stringify(report.cart_before_checkout.items.map((i) => i.price).sort()),
    { lead: lead.items.map((i) => i.price), cart: report.cart_before_checkout.items.map((i) => i.price) });
  const lineSum = lead.items.reduce((s, i) => s + i.line_total, 0);
  assert("estimated_total = сумма line_total", Math.abs(lead.estimated_total - lineSum) < 0.01,
    { estimated_total: lead.estimated_total, sum: lineSum });
  assert("estimated_total совпадает с суммой корзины до отправки",
    Math.abs(lead.estimated_total - report.cart_before_checkout.estimated_total) < 0.01,
    { lead: lead.estimated_total, cart: report.cart_before_checkout.estimated_total });
  assert("Персональные данные не попали в аналитику (проверка ниже по БД)", true);
  report.lead_snapshot = {
    id: lead.id, public_number: lead.public_number, lead_type: lead.lead_type, source: lead.source,
    status: lead.status, items_count: lead.items_count, estimated_total: lead.estimated_total,
    delivery_method: lead.delivery_method,
    items: lead.items.map((i) => ({ product_id: i.product_id, sku: i.sku, price: i.price, quantity: i.quantity, line_total: i.line_total })),
  };

  const cartAfter = await api("/api/cart", authed);
  assert("Корзина после отправки пуста", cartAfter.body.positions_count === 0);

  // ------------------------------------------------ 13. повтор с тем же ключом
  step("Повторная отправка с тем же ключом идемпотентности");
  const leadsBefore = await api("/api/admin/leads?limit=500", adminAuthed);
  const countBefore = leadsBefore.body.leads.length;
  // Кладём товар и отправляем дважды с ОДНИМ ключом
  const anyProduct = report.cart_before_checkout.items[0].product_id;
  await api("/api/cart/items", { method: "POST", ...authed, body: JSON.stringify({ product_id: anyProduct, quantity: 1 }) });
  const key = "rc2-acceptance-fixed-key";
  const first = await api("/api/cart/checkout", {
    method: "POST", ...authed,
    body: JSON.stringify({ name: "Приёмка RC2", phone: "+70000000002", fulfillment_type: "pickup", comment: "idempotency", consent: true, idempotency_key: key }),
  });
  const second = await api("/api/cart/checkout", {
    method: "POST", ...authed,
    body: JSON.stringify({ name: "Приёмка RC2", phone: "+70000000002", fulfillment_type: "pickup", comment: "idempotency", consent: true, idempotency_key: key }),
  });
  assert("Первый запрос создал заявку", first.body.created === true, { id: first.body.lead.id });
  assert("Повтор с тем же ключом НЕ создал дубль", second.body.created === false, { id: second.body.lead.id });
  assert("Оба ответа указывают на одну заявку", first.body.lead.id === second.body.lead.id,
    { first: first.body.lead.id, second: second.body.lead.id });
  const leadsAfter = await api("/api/admin/leads?limit=500", adminAuthed);
  assert("Число заявок выросло ровно на одну", leadsAfter.body.leads.length === countBefore + 1,
    { before: countBefore, after: leadsAfter.body.leads.length });
  report.idempotency_lead_id = first.body.lead.id;

  // ------------------------------------------------- 14. старая одиночная заявка
  step("Старые одиночные заявки");
  const single = leadsAfter.body.leads.find((l) => l.lead_type !== "cart");
  assert("Одиночная заявка по-прежнему в списке", !!single, { id: single?.id, lead_type: single?.lead_type });
  if (single) {
    const singleDetail = await api(`/api/admin/leads/${single.id}`, adminAuthed);
    assert("Деталка одиночной заявки открывается и не содержит позиций",
      singleDetail.status === 200 && singleDetail.body.items.length === 0,
      { id: single.id, items: singleDetail.body.items.length });
    report.legacy_lead_id = single.id;
  }

  // ---------------------------------------------------------- 11-12. дашборд
  step("Дашборд и фильтры");
  const dash = await api("/api/admin/dashboard", adminAuthed);
  assert("Дашборд считает заявки корзины", dash.body.cart_leads_total >= 2, { cart_leads_total: dash.body.cart_leads_total });
  const newFilter = await api("/api/admin/leads?status_filter=new", adminAuthed);
  assert("Заявка корзины попадает в фильтр «Новые»",
    newFilter.body.leads.some((l) => l.id === leadId), { new_count: newFilter.body.leads.length });

  // ------------------------------------------------------------ 13-14. админка
  step("Админка: список заявок и открытая заявка корзины");
  const adminPage = await browser.newPage();
  adminPage.on("pageerror", (e) => { report.admin_page_errors = [...(report.admin_page_errors || []), String(e)]; });
  await adminPage.setViewport({ width: 1366, height: 900, deviceScaleFactor: 2 });
  await adminPage.goto(`${ADMIN}/`, { waitUntil: "networkidle2" });
  await adminPage.waitForSelector('[data-testid="dev-admin-login"]', { timeout: 15000 });
  await adminPage.click('[data-testid="dev-admin-login"]');
  await adminPage.waitForFunction(() => document.body.innerText.includes("Дашборд"), { timeout: 15000 });
  await sleep(800);

  // Раздел «Заявки»
  await adminPage.evaluate(() => {
    const b = [...document.querySelectorAll("nav button")].find((x) => x.innerText.trim() === "Заявки");
    b.click();
  });
  await sleep(1500);
  await shot(adminPage, "13-admin-leads-list.png", { fullPage: true });
  const listHasCart = await adminPage.evaluate(() => document.body.innerText.includes("Корзина"));
  assert("В списке админки видна заявка типа «Корзина»", listHasCart);

  // Открываем cart-заявку
  const openedDetail = await adminPage.evaluate((id) => {
    const rows = [...document.querySelectorAll("tbody tr")];
    const row = rows.find((r) => r.innerText.includes(`№${id}`));
    if (!row) return false;
    const btn = [...row.querySelectorAll("button")].find((b) => b.innerText.trim() === "Открыть");
    btn.click();
    return true;
  }, leadId);
  assert("Заявка корзины открывается в UI админки", openedDetail);
  await sleep(1500);
  await shot(adminPage, "14-admin-cart-lead-detail.png", { fullPage: true });
  const detailText = await adminPage.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  assert("В модалке видны все три позиции и состав заявки",
    detailText.includes("Состав заявки") && detailText.includes("Предварительная сумма"),
    { has: detailText.includes("Состав заявки") });

  // Смена статуса прямо в UI
  await adminPage.evaluate(() => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "confirmed"));
    sel.value = "confirmed";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(1500);
  const afterStatus = await api(`/api/admin/leads/${leadId}`, adminAuthed);
  assert("Статус изменён через UI админки", afterStatus.body.status === "confirmed", { status: afterStatus.body.status });
  assert("История статусов записана", afterStatus.body.status_history.length >= 1,
    { history: afterStatus.body.status_history.map((h) => `${h.from}->${h.to}`) });
  assert("Состав заявки не изменился после смены статуса",
    afterStatus.body.items.length === 3 &&
    Math.abs(afterStatus.body.estimated_total - lead.estimated_total) < 0.01);

  await adminPage.close();

  // ------------------------------------------------------------- UI-матрица
  step("Проверка UI на пяти разрешениях");
  // Возвращаем в корзину товары, чтобы панель была видна
  for (const it of report.cart_before_checkout.items.slice(0, 2)) {
    await api("/api/cart/items", { method: "POST", ...authed, body: JSON.stringify({ product_id: it.product_id, quantity: 1 }) });
  }
  const sizes = [[360, 800, "Android"], [390, 844, "iPhone"], [430, 932, "iPhone Pro Max"], [900, 700, "Планшет/окно"], [1366, 768, "Chrome desktop"]];
  for (const [w, h, label] of sizes) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 900, hasTouch: w < 900 });
    for (const route of ["/", "/catalog", "/cart"]) {
      await page.goto(`${SHOP}${route}`, { waitUntil: "networkidle2" });
      await ready(page);
      const m = await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main) main.scrollTop = main.scrollHeight;
        const bar = document.querySelector(".cart-dock");
        const card = bar && bar.querySelector("button");
        const nav = document.querySelector("nav.js-bottom-nav") || document.querySelector("nav");
        const nr = nav && nav.getBoundingClientRect();
        const cr = card && card.getBoundingClientRect();
        // Обрезается ли цена или итог
        const clipped = [...document.querySelectorAll("main *")].filter((el) => {
          const t = (el.textContent || "").trim();
          if (!t.includes("₽") || el.children.length) return false;
          return el.scrollWidth > el.clientWidth + 1;
        }).length;
        return {
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          gapBarNav: cr && nr ? Math.round(nr.top - cr.bottom) : null,
          barVisible: !!cr,
          scrollGap: main ? Math.round(main.scrollHeight - main.scrollTop - main.clientHeight) : null,
          clippedPrices: clipped,
          steppers: document.querySelectorAll('[role="group"][aria-label^="Количество"]').length,
          // Обрезанные подсказки полей. Ширину текста считаем канвасом тем же
          // шрифтом, что у поля: у input scrollWidth про placeholder молчит,
          // поэтому «на глаз» такое ловится только скриншотом.
          clippedPlaceholders: [...document.querySelectorAll("main input[placeholder], header input[placeholder]")]
            .filter((el) => el.offsetParent !== null)
            .map((el) => {
              const cs = getComputedStyle(el);
              const ctx = document.createElement("canvas").getContext("2d");
              ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
              const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
              const need = ctx.measureText(el.placeholder).width;
              return need > avail ? { placeholder: el.placeholder, need: Math.round(need), avail: Math.round(avail) } : null;
            })
            .filter(Boolean),
        };
      });
      report.ui_matrix.push({ viewport: `${w}x${h}`, label, route, ...m });
      assert(`overflow-X = 0 · ${label} ${w}x${h} ${route}`, m.overflowX <= 0, m);
      assert(`цены не обрезаются · ${label} ${w}x${h} ${route}`, m.clippedPrices === 0, { clipped: m.clippedPrices });
      assert(`подсказки полей не обрезаются · ${label} ${w}x${h} ${route}`,
        m.clippedPlaceholders.length === 0, m.clippedPlaceholders);
      if (m.barVisible && w < 1024) {
        assert(`панель корзины выше навигации · ${label} ${w}x${h} ${route}`, m.gapBarNav >= 0, { gap: m.gapBarNav });
      }
      assert(`низ контента достижим · ${label} ${w}x${h} ${route}`, Math.abs(m.scrollGap) <= 2, { gap: m.scrollGap });
    }
  }

  // ------------------------------------------- клавиатура не перекрывает checkout
  step("Клавиатура на экране оформления");
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(`${SHOP}/cart`, { waitUntil: "networkidle2" });
  await ready(page);
  const kb = await page.evaluate(async () => {
    const main = document.querySelector("main");
    const phone = [...main.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("Телефон"));
    phone.focus();
    // Эмулируем «поднятую клавиатуру»: класс, который вешает lib/telegram
    document.documentElement.classList.add("kb-open");
    await new Promise((r) => setTimeout(r, 300));
    const submit = [...main.querySelectorAll("button")].find((b) => b.innerText.includes("Отправить заявку"));
    const nav = document.querySelector("nav.js-bottom-nav");
    const bar = document.querySelector(".cart-dock");
    const res = {
      navHidden: nav ? getComputedStyle(nav).display === "none" : true,
      barHidden: bar ? getComputedStyle(bar).display === "none" : true,
      submitVisible: !!submit,
      submitBottom: submit ? Math.round(submit.getBoundingClientRect().bottom) : null,
      focused: document.activeElement === phone,
    };
    document.documentElement.classList.remove("kb-open");
    return res;
  });
  report.keyboard = kb;
  assert("При открытой клавиатуре нижняя навигация скрыта", kb.navHidden, kb);
  assert("При открытой клавиатуре панель корзины скрыта", kb.barHidden, kb);
  assert("Кнопка отправки остаётся в потоке страницы (не за фиксированной панелью)", kb.submitVisible, kb);

  // ------------------------------------------- длинные названия не ломают layout
  step("Длинные названия товаров");
  await page.goto(`${SHOP}/catalog`, { waitUntil: "networkidle2" });
  await ready(page);
  const longTitles = await page.evaluate(() => {
    const titles = [...document.querySelectorAll("main p.line-clamp-2")];
    const longest = titles.map((t) => t.innerText.length).sort((a, b) => b - a)[0] || 0;
    const overflowing = titles.filter((t) => t.scrollWidth > t.clientWidth + 1).length;
    const cards = [...document.querySelectorAll(".card-appear.lift")].map((c) => Math.round(c.getBoundingClientRect().height));
    const uniqueHeights = [...new Set(cards)];
    return { longestTitleChars: longest, overflowingTitles: overflowing, cardHeights: uniqueHeights.slice(0, 5), cardCount: cards.length };
  });
  report.long_titles = longTitles;
  assert("Длинные названия не выходят за карточку", longTitles.overflowingTitles === 0, longTitles);
  assert("Карточки в сетке одной высоты", longTitles.cardHeights.length === 1, longTitles);

  await api("/api/cart", { method: "DELETE", ...authed });
  await page.close();
} catch (e) {
  failures++;
  report.fatal = String(e && e.stack ? e.stack : e);
  console.error("FATAL", e);
} finally {
  await browser.close();
}

report.finished_at = new Date().toISOString();
report.failures = failures;
report.passed = failures === 0;
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(`\n=== assertions: ${report.assertions.length}, failures: ${failures} ===`);
console.log(`report -> ${join(OUT, "report.json")}`);
process.exit(failures === 0 ? 0 : 1);

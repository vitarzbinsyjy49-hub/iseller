import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import { ErrorState } from "../components/StateViews";

/** РСЃС‚РѕСЂРёСЏ РїСЂРѕСЃРјРѕС‚СЂРѕРІ (/history): СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ /catalog/recently-viewed,
 *  РЅРёРєР°РєРѕР№ РЅРѕРІРѕР№ С‚Р°Р±Р»РёС†С‹. РљР°СЂС‚РѕС‡РєРё СЃ РёР·Р±СЂР°РЅРЅС‹Рј Рё РїРµСЂРµС…РѕРґРѕРј РІ ProductDetails.
 *  РџСѓРЅРєС‚ В«РСЃС‚РѕСЂРёСЏ РїСЂРѕСЃРјРѕС‚СЂРѕРІВ» РІ РїСЂРѕС„РёР»Рµ СЂР°РЅСЊС€Рµ Р±С‹Р» Р·Р°РіР»СѓС€РєРѕР№ В«РЎРєРѕСЂРѕВ». */
export default function History() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<TCard[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    setCards(null);
    setError(false);
    // limit=20 вЂ” РјР°РєСЃРёРјСѓРј, РєРѕС‚РѕСЂС‹Р№ РґРѕРїСѓСЃРєР°РµС‚ СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ endpoint (ge=1, le=20)
    api<{ cards?: TCard[] }>("/catalog/recently-viewed?limit=20")
      .then((d) => setCards(Array.isArray(d.cards) ? d.cards : []))
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    track("history_opened");
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-md lg:max-w-none">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">РСЃС‚РѕСЂРёСЏ РїСЂРѕСЃРјРѕС‚СЂРѕРІ</h1>
        {cards && cards.length > 0 && <span className="text-sm text-muted">{cards.length}</span>}
      </div>

      {error ? (
        <div className="mt-6"><ErrorState message="РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ РёСЃС‚РѕСЂРёСЋ" onRetry={load} /></div>
      ) : cards === null ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton aspect-[3/4] rounded-xl2" />)}
        </div>
      ) : cards.length === 0 ? (
        <div className="fade-in mt-14 text-center">
          <div className="text-4xl">рџ•ђ</div>
          <p className="mt-3 text-[15px] font-bold">Р’С‹ РїРѕРєР° РЅРёС‡РµРіРѕ РЅРµ СЃРјРѕС‚СЂРµР»Рё</p>
          <p className="mx-auto mt-1 max-w-[280px] text-sm text-muted">
            РћС‚РєСЂС‹РІР°Р№С‚Рµ РєР°СЂС‚РѕС‡РєРё С‚РѕРІР°СЂРѕРІ вЂ” РѕРЅРё РїРѕСЏРІСЏС‚СЃСЏ Р·РґРµСЃСЊ, С‡С‚РѕР±С‹ Рє РЅРёРј Р±С‹Р»Рѕ Р»РµРіРєРѕ РІРµСЂРЅСѓС‚СЊСЃСЏ.
          </p>
          <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
            <button
              onClick={() => {
                track("empty_state_action_clicked", { source: "history_catalog" });
                navigate("/catalog");
              }}
              className="tap rounded-xl2 bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
            >
              РћС‚РєСЂС‹С‚СЊ РєР°С‚Р°Р»РѕРі
            </button>
            <button
              onClick={() => {
                track("empty_state_action_clicked", { source: "history_ai" });
                navigate("/ai");
              }}
              className="tap rounded-xl2 bg-surface px-5 py-2.5 text-sm font-semibold text-accent shadow-soft"
            >
              вњЁ РџРѕРґРѕР±СЂР°С‚СЊ С‡РµСЂРµР· AI
            </button>
          </div>
        </div>
      ) : (
        <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4 wide:grid-cols-5">
          {cards.map((c) => <ProductCard key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}

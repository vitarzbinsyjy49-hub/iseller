/** Live-поиск по каталогу: debounce + AbortController + защита от гонок.
 *
 *  Раньше подсказки на главной делались setTimeout'ом без отмены запроса —
 *  медленный старый ответ мог перезаписать более свежий. Здесь:
 *  - debounce (по умолчанию 300 мс);
 *  - предыдущий запрос отменяется через AbortController;
 *  - seq-guard: применяется только ответ последнего запроса;
 *  - на размонтировании всё отменяется (нет setState after unmount).
 *
 *  Это обычный детерминированный поиск /catalog/search — НЕ AI.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProductCard as TCard } from "../components/ai/types";

export const LIVE_SEARCH_DEBOUNCE_MS = 300;
export const MIN_QUERY_LEN = 2;

export type LiveSearchState = {
  /** null — запрос короткий/панель результатов не нужна; [] — «не нашлось». */
  results: TCard[] | null;
  searching: boolean;
};

export function useLiveSearch(query: string, limit = 5): LiveSearchState {
  const [state, setState] = useState<LiveSearchState>({ results: null, searching: false });
  const seqRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LEN) {
      setState({ results: null, searching: false });
      return;
    }
    const seq = ++seqRef.current;
    setState((s) => ({ ...s, searching: true }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api<{ cards?: TCard[] }>(
        `/catalog/search?query=${encodeURIComponent(q)}&limit=${limit}`,
        { signal: controller.signal },
      )
        .then((d) => {
          if (seq !== seqRef.current) return; // пришёл устаревший ответ
          setState({ results: Array.isArray(d.cards) ? d.cards : [], searching: false });
        })
        .catch(() => {
          if (seq !== seqRef.current || controller.signal.aborted) return;
          setState({ results: [], searching: false });
        });
    }, LIVE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, limit]);

  return state;
}

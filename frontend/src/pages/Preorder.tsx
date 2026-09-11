import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { cachedApi } from "../lib/apiCache";
import { ErrorState } from "../components/StateViews";
import PreorderEvent, {
  PreorderSkeleton, type EventBanner, type EventItem,
} from "../components/PreorderEvent";

type EventData = { banner: EventBanner | null; items: EventItem[] };

/** Экран события предзаказа по адресу `/preorder/:group`.
 *
 *  Страница отвечает только за загрузку: сам экран рисует PreorderEvent. Пустая
 *  группа — НЕ ошибка: она пустеет сама, когда товары приехали и стали
 *  обычными, и об этом состоянии экран говорит словами (см. PreorderEvent).
 *  Ошибкой здесь считается только несостоявшийся запрос.
 */
export default function Preorder() {
  const { group = "" } = useParams();
  const [data, setData] = useState<EventData | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    cachedApi<EventData>(`/preorder/${encodeURIComponent(group)}`)
      .then(setData)
      .catch(() => setFailed(true));
  }, [group]);

  useEffect(load, [load]);

  if (failed) {
    return (
      <div className="mx-auto max-w-md py-10">
        <ErrorState message="Не удалось загрузить событие" onRetry={load} />
      </div>
    );
  }
  if (!data) return <PreorderSkeleton />;

  return <PreorderEvent banner={data.banner} items={data.items} />;
}

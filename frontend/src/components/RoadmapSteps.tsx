/** Рендер роудмапа: группы-периоды и пункты внутри них.
 *
 *  Один компонент на три шторки (приложение, AI, баллы). Вёрстка списка была
 *  скопирована трижды и трижды же расходилась по мелочам; отличается между
 *  экранами ровно одно — цвет акцента, и он вынесен в параметр.
 *
 *  Нумерации нет намеренно. Номер обещает очередь, а очередь внутри месяца не
 *  определена: пункты сентября делаются параллельно.
 */
import { PERIOD_LABEL, roadmapFor, type RoadmapTrack } from "../lib/roadmap";

export default function RoadmapSteps({
  track,
  accentColor,
}: {
  track: RoadmapTrack;
  /** Явный цвет (шторка AI берёт оранжевый Claude). Без него — акцент темы. */
  accentColor?: string;
}) {
  const groups = roadmapFor(track);

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.period}>
          <p
            className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em] ${
              accentColor ? "" : "bg-accent/10 text-accent"
            }`}
            style={
              accentColor
                ? { backgroundColor: `${accentColor}1a`, color: accentColor }
                : undefined
            }
          >
            {PERIOD_LABEL[group.period]}
          </p>

          <ul className="mt-2.5 space-y-3">
            {group.items.map((item) => (
              <li key={item.id} className="flex gap-3">
                <span
                  className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${
                    accentColor ? "" : "bg-accent"
                  }`}
                  style={accentColor ? { backgroundColor: accentColor } : undefined}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold leading-5">{item.title}</p>
                  <p className="mt-1 text-[12.5px] leading-[1.45] text-muted">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

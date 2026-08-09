/** Самопочинка приложения, оставшегося на сборке, которой больше нет.
 *
 *  Страницы грузятся лениво, и имя каждого chunk содержит хэш содержимого.
 *  Деплой выкладывает новые имена, старые с сервера исчезают. Приложение,
 *  открытое до выкладки, продолжает работать: уже загруженные экраны живут в
 *  памяти. Но первый же переход на экран, которого ещё не было, уходит за
 *  старое имя — и получает 404. `import()` отклоняется, React бросает, человек
 *  видит «Что-то пошло не так» на совершенно исправном приложении.
 *
 *  Так и случилось на релизе 09.08: «Заявки» не открывались у тех, у кого
 *  Mini App оставался тёплым с момента до деплоя, и лечилось только ручной
 *  чисткой кэша.
 *
 *  Корень чинится на сервере (index.html обязан перепроверяться, см.
 *  frontend/nginx.conf), здесь — вторая линия: если chunk не нашёлся, один раз
 *  перезагружаем приложение. Перезагрузка возьмёт свежий index.html с новыми
 *  именами, и человек ничего не заметит.
 *
 *  Ровно один раз: если файла действительно нет, вторая попытка даст то же
 *  самое, и приложение уйдёт в цикл перезагрузок — состояние хуже исходного.
 */

/** Сообщения браузеров об отсутствующем chunk. Формулировки разные у каждого
 *  движка, поэтому проверяем все: Chrome, Firefox, Safari и preload Vite. */
const CHUNK_ERROR_PATTERN =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_ERROR_PATTERN.test(error.message);
}

export function shouldReloadForStaleChunk(error: unknown, alreadyReloaded: boolean): boolean {
  return !alreadyReloaded && isChunkLoadError(error);
}

/** Окружение перезагрузки. Вынесено параметром, чтобы решение проверялось
 *  тестом без настоящих sessionStorage и location. */
export type ReloadEnv = {
  hasReloaded: () => boolean;
  markReloaded: () => void;
  reload: () => void;
};

const FLAG = "stale-chunk-reloaded";

/** Признак живёт в sessionStorage: он умирает вместе с вкладкой, поэтому
 *  следующий запуск снова имеет право на одну попытку. Доступ к хранилищу
 *  бывает запрещён (приватный режим, часть WebView) — тогда считаем, что
 *  перезагрузка уже была, и ошибка просто идёт наверх. */
export const browserReloadEnv: ReloadEnv = {
  hasReloaded: () => {
    try {
      return sessionStorage.getItem(FLAG) === "1";
    } catch {
      return true;
    }
  },
  markReloaded: () => {
    try {
      sessionStorage.setItem(FLAG, "1");
    } catch {
      /* хранилище недоступно — перезагрузку всё равно делаем, но одну */
    }
  },
  reload: () => window.location.reload(),
};

/** Оборачивает загрузчик экрана. Возвращаемый промис при перезагрузке НЕ
 *  отклоняется намеренно: страница уже уходит на reload, и отдать React отказ
 *  значит мигнуть экраном ошибки поверх уходящей страницы. */
export function withStaleChunkReload<T>(
  load: () => Promise<T>,
  env: ReloadEnv = browserReloadEnv,
): () => Promise<T> {
  return () =>
    load().catch((error: unknown) => {
      if (!shouldReloadForStaleChunk(error, env.hasReloaded())) throw error;
      env.markReloaded();
      env.reload();
      return new Promise<T>(() => {});
    });
}

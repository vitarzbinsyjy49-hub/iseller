/** Счётчик заявок и непросмотренных изменений по ним.
 *
 *  Зачем стор, а не состояние страницы. Цифру показывают ДВА места сразу —
 *  кнопка в профиле и точка на вкладке «Профиль» в нижней навигации, которая
 *  живёт в Layout и переживает переходы между страницами. Пока счёт лежал в
 *  Profile.tsx, второе место могло получить его только собственным запросом:
 *  два обращения к /leads/my на каждый заход в приложение ради одного и того
 *  же числа.
 *
 *  Почему отметка о просмотре в localStorage, а не колонкой в users. Колонка
 *  дала бы синхронизацию между устройствами, но стоила бы мини-миграции и
 *  обязательного добавления в REQUIRED_SCHEMA бота — иначе он падает
 *  UndefinedColumn на первом же деплое. Всё это ради подсветки, которая живёт
 *  до первого открытия раздела, у пользователя, который почти всегда на одном
 *  устройстве. Понадобится синхронизация — поднимем отдельной задачей.
 */
import { create } from "zustand";

import { api } from "../lib/api";
import { unseenLeadCount, type LeadSeenLike } from "../lib/leads";

const SEEN_KEY = "leads_seen_at";

/** Хранилище может быть недоступно (приватный режим, отключённые куки).
 *  Отсутствие отметки — не ошибка: бейдж просто не зажигается. */
function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(iso: string): void {
  try {
    localStorage.setItem(SEEN_KEY, iso);
  } catch {
    /* подсветка — не то, ради чего стоит падать */
  }
}

type LeadsBadgeState = {
  /** Всего заявок. null — ещё не спрашивали. */
  total: number | null;
  /** Изменившихся с последнего просмотра. */
  unseen: number;
  refresh: () => Promise<void>;
  markSeen: () => void;
};

export const useLeadsBadge = create<LeadsBadgeState>((set) => ({
  total: null,
  unseen: 0,
  refresh: async () => {
    try {
      const d = await api<{ leads: LeadSeenLike[] }>("/leads/my");
      set({ total: d.leads.length, unseen: unseenLeadCount(d.leads, readSeen()) });
    } catch {
      // Сбой запроса оставляет счётчик нейтральным. Ошибка в бейдже пугает
      // сильнее, чем отсутствие цифры, — то же правило, что у блока лояльности.
      set({ total: 0, unseen: 0 });
    }
  },
  markSeen: () => {
    writeSeen(new Date().toISOString());
    set({ unseen: 0 });
  },
}));

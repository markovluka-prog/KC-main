/**
 * Admin allow-list.
 *
 * ⚠️ Это КЛИЕНТСКАЯ проверка — она удобна для «открыть всё в игре» и отладочных
 * инструментов (локальные удобства), но НЕ является защитой: технически продвинутый
 * пользователь может обойти её, отредактировав JS. Для привилегированных серверных
 * действий нужна проверка роли на стороне Supabase (RLS / JWT claims).
 *
 * ЧТОБЫ ДОБАВИТЬ/УБРАТЬ АДМИНА — отредактируй массив ниже, затем пересобери веб
 * (vite build) и обнови приложение. Регистр email не важен.
 */
export const ADMIN_EMAILS: readonly string[] = [
  'markov.luka@icloud.com',
  // 'another.admin@example.com',
];

/** True, если email есть в списке админов (без учёта регистра). */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

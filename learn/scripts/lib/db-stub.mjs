// In-memory D1 stub for talvi learn Worker smoke + e2e tests.
// Extracted from ui-smoke-test.mjs (makeDb, lines 37-96) so both
// ui-smoke-test and dev-serve/e2e can share one implementation.
// Same shape as data-smoke-test.mjs — only the methods the Worker touches.
export function makeDb() {
  const tables = { xp_events: [], lesson_progress: [], player_state: [] };
  const db = {
    async batch(stmts) {
      for (const s of stmts) await s.run();
    },
    prepare(sql) {
      const stmt = {
        async run(...args) {
          const values = args.length ? args : this._args || [];
          if (/CREATE TABLE|CREATE INDEX/i.test(sql)) return { meta: {} };
          if (/INSERT OR IGNORE INTO xp_events/.test(sql)) {
            const [ts, lessonId, skill, xp] = values;
            if (tables.xp_events.some((r) => r.lesson_id === lessonId)) return { meta: { changes: 0 } };
            tables.xp_events.push({ id: tables.xp_events.length + 1, ts, lesson_id: lessonId, skill, xp });
            return { meta: { changes: 1 } };
          }
          if (/INSERT OR REPLACE INTO lesson_progress/.test(sql)) {
            const [userId, lessonId, state, bestScore, attempts, lastCompletedAt] = values;
            tables.lesson_progress = tables.lesson_progress.filter((r) => !(r.user_id === userId && r.lesson_id === lessonId));
            tables.lesson_progress.push({ user_id: userId, lesson_id: lessonId, state, best_score: bestScore, attempts, last_completed_at: lastCompletedAt });
            return { meta: {} };
          }
          if (/INSERT OR REPLACE INTO player_state/.test(sql)) {
            const [userId, xp, streakDays, lastDay, hearts, level, updatedAt] = values;
            tables.player_state = tables.player_state.filter((r) => r.user_id !== userId);
            tables.player_state.push({ user_id: userId, xp, streak_days: streakDays, last_day: lastDay, hearts, level, updated_at: updatedAt });
            return { meta: {} };
          }
          return { meta: {} };
        },
        async all(..._args) {
          if (/FROM xp_events/.test(sql)) return { results: tables.xp_events.slice() };
          if (/FROM lesson_progress/.test(sql)) return { results: tables.lesson_progress.slice() };
          return { results: [] };
        },
        async first(...args) {
          if (/FROM lesson_progress/.test(sql)) {
            const [userId, lessonId] = args.length ? args : this._args || [];
            return tables.lesson_progress.find((r) => r.user_id === userId && r.lesson_id === lessonId) || null;
          }
          if (/FROM player_state/.test(sql)) {
            const [userId] = args.length ? args : this._args || [];
            return tables.player_state.find((r) => r.user_id === userId) || null;
          }
          if (/SUM\(xp\)/.test(sql)) {
            return { total: tables.xp_events.reduce((a, r) => a + Number(r.xp || 0), 0) };
          }
          return null;
        },
        bind(...args) {
          this._args = args;
          return this;
        },
      };
      return stmt;
    },
  };
  return { db, tables };
}

import { authenticate, jsonResponse, handleOptions } from './_helpers.js';

export async function onRequest(context) {
  var { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  var user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  var { code, score, correct, total, stars } = body;
  if (!code) return jsonResponse({ error: 'Quiz code required' }, 400);

  var db = env.DB;

  // Always insert a new quiz attempt (quiz results are historical)
  await db.prepare(
    'INSERT INTO quiz_results (student_id, quiz_code, score, correct, total, stars, completed_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
  ).bind(user.student_id, code, score || 0, correct || 0, total || 0, stars || 0).run();

  // Add XP for quiz
  var xpEarned = (correct || 0) * 5;
  var coinBonus = (stars >= 3) ? 15 : 0;

  await db.prepare(
    'UPDATE progress SET xp = xp + ?, coins = coins + ?, last_active = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP WHERE student_id = ?'
  ).bind(xpEarned, coinBonus, user.student_id).run();

  return jsonResponse({ ok: true, xp_earned: xpEarned });
}

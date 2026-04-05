import { authenticate, jsonResponse, handleOptions } from './_helpers.js';

export async function onRequest(context) {
  var { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();

  var user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  var db = env.DB;

  if (request.method === 'GET') {
    var progress = await db.prepare(
      'SELECT xp, coins, pts, streak_days, level, last_active FROM progress WHERE student_id = ?'
    ).bind(user.student_id).first();

    var missions = await db.prepare(
      'SELECT mission_code, status, stars, score, xp_earned FROM mission_results WHERE student_id = ?'
    ).bind(user.student_id).all();

    var quizzes = await db.prepare(
      'SELECT quiz_code, score, correct, total, stars FROM quiz_results WHERE student_id = ? ORDER BY completed_at DESC'
    ).bind(user.student_id).all();

    return jsonResponse({
      progress: progress || { xp: 0, coins: 0, pts: 0, streak_days: 0, level: 'easy' },
      missions: missions.results || [],
      quizzes: quizzes.results || []
    });
  }

  if (request.method === 'POST') {
    var body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    // Upsert progress — only update fields that are provided
    var fields = [];
    var values = [];

    if (body.xp !== undefined) { fields.push('xp = ?'); values.push(body.xp); }
    if (body.coins !== undefined) { fields.push('coins = ?'); values.push(body.coins); }
    if (body.pts !== undefined) { fields.push('pts = ?'); values.push(body.pts); }
    if (body.streak_days !== undefined) { fields.push('streak_days = ?'); values.push(body.streak_days); }
    if (body.level !== undefined) { fields.push('level = ?'); values.push(body.level); }

    if (fields.length === 0) return jsonResponse({ error: 'No fields to update' }, 400);

    fields.push('last_active = CURRENT_DATE');
    fields.push('updated_at = CURRENT_TIMESTAMP');

    var sql = 'UPDATE progress SET ' + fields.join(', ') + ' WHERE student_id = ?';
    values.push(user.student_id);

    var stmt = db.prepare(sql);
    await stmt.bind(...values).run();

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

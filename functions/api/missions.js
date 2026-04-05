import { authenticate, jsonResponse, handleOptions } from './_helpers.js';

export async function onRequest(context) {
  var { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();

  var user = await authenticate(request, env);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  var db = env.DB;

  if (request.method === 'GET') {
    var results = await db.prepare(
      'SELECT mission_code, status, stars, score, xp_earned, attempts, completed_at FROM mission_results WHERE student_id = ?'
    ).bind(user.student_id).all();

    return jsonResponse({ missions: results.results || [] });
  }

  if (request.method === 'POST') {
    var body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    var { code, stars, score, xp_earned } = body;
    if (!code) return jsonResponse({ error: 'Mission code required' }, 400);

    stars = stars || 0;
    score = score || 0;
    xp_earned = xp_earned || 0;

    // Upsert: insert or update if better score
    var existing = await db.prepare(
      'SELECT id, score, attempts FROM mission_results WHERE student_id = ? AND mission_code = ?'
    ).bind(user.student_id, code).first();

    if (existing) {
      // Update if better score, always increment attempts
      var newScore = Math.max(existing.score, score);
      var newStars = Math.max(existing.stars || 0, stars);
      await db.prepare(
        'UPDATE mission_results SET status = ?, stars = ?, score = ?, xp_earned = ?, attempts = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind('cleared', newStars, newScore, xp_earned, existing.attempts + 1, existing.id).run();
    } else {
      await db.prepare(
        'INSERT INTO mission_results (student_id, mission_code, status, stars, score, xp_earned, attempts, completed_at) VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)'
      ).bind(user.student_id, code, 'cleared', stars, score, xp_earned).run();
    }

    // Update progress XP and coins
    var coinBonus = stars >= 3 ? 30 : 20;
    await db.prepare(
      'UPDATE progress SET xp = xp + ?, coins = coins + ?, last_active = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP WHERE student_id = ?'
    ).bind(xp_earned, coinBonus, user.student_id).run();

    // Get updated progress
    var progress = await db.prepare(
      'SELECT xp, coins, pts FROM progress WHERE student_id = ?'
    ).bind(user.student_id).first();

    return jsonResponse({ ok: true, new_xp: progress.xp, new_coins: progress.coins });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

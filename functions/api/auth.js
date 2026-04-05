import { hashPin, createJWT, jsonResponse, handleOptions } from './_helpers.js';

export async function onRequest(context) {
  var { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  var { action, name, pin } = body;
  if (!name || !pin) return jsonResponse({ error: 'Name and PIN required' }, 400);

  name = name.trim();
  pin = pin.trim();

  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return jsonResponse({ error: 'PIN must be exactly 4 digits' }, 400);
  }

  var pinHash = await hashPin(pin);
  var db = env.DB;

  if (action === 'register') {
    // Check if name already exists
    var existing = await db.prepare('SELECT id FROM students WHERE name = ?').bind(name).first();
    if (existing) return jsonResponse({ error: 'Name already taken' }, 409);

    // Insert student
    var result = await db.prepare(
      'INSERT INTO students (name, pin_hash, last_login) VALUES (?, ?, CURRENT_TIMESTAMP)'
    ).bind(name, pinHash).run();

    var studentId = result.meta.last_row_id;

    // Create initial progress row
    await db.prepare(
      'INSERT INTO progress (student_id, xp, coins, pts, streak_days, level, last_active, updated_at) VALUES (?, 0, 0, 0, 0, ?, CURRENT_DATE, CURRENT_TIMESTAMP)'
    ).bind(studentId, 'easy').run();

    var token = await createJWT({ student_id: studentId, name: name }, env.JWT_SECRET);

    return jsonResponse({
      token: token,
      student: { id: studentId, name: name },
      progress: { xp: 0, coins: 0, pts: 0, streak_days: 0, level: 'easy' }
    });
  }

  if (action === 'login') {
    var student = await db.prepare(
      'SELECT id, name, pin_hash FROM students WHERE name = ?'
    ).bind(name).first();

    if (!student || student.pin_hash !== pinHash) {
      return jsonResponse({ error: 'Invalid name or PIN' }, 401);
    }

    // Update last login
    await db.prepare(
      'UPDATE students SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(student.id).run();

    // Load progress
    var progress = await db.prepare(
      'SELECT xp, coins, pts, streak_days, level, last_active FROM progress WHERE student_id = ?'
    ).bind(student.id).first();

    if (!progress) {
      progress = { xp: 0, coins: 0, pts: 0, streak_days: 0, level: 'easy' };
    }

    // Load mission results
    var missions = await db.prepare(
      'SELECT mission_code, status, stars, score FROM mission_results WHERE student_id = ?'
    ).bind(student.id).all();

    var token = await createJWT({ student_id: student.id, name: student.name }, env.JWT_SECRET);

    return jsonResponse({
      token: token,
      student: { id: student.id, name: student.name },
      progress: progress,
      missions: missions.results || []
    });
  }

  return jsonResponse({ error: 'Invalid action. Use "register" or "login"' }, 400);
}

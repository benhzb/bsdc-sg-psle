import { authenticate, jsonResponse, handleOptions } from './_helpers.js';

export async function onRequest(context) {
  var { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();

  // GET: list jobs or fetch a specific job result
  if (request.method === 'GET') {
    var user = await authenticate(request, env);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    var url = new URL(request.url);
    var jobId = url.searchParams.get('job_id');
    var listMode = url.searchParams.get('list');

    if (jobId) {
      var job = await env.DB.prepare(
        'SELECT id, status, result, created_at, completed_at FROM scan_jobs WHERE id = ? AND student_id = ?'
      ).bind(jobId, user.student_id).first();
      if (!job) return jsonResponse({ error: 'Job not found' }, 404);
      var result = job.result;
      if (result) {
        try { result = JSON.parse(result); } catch (e) {}
      }
      return jsonResponse({ id: job.id, status: job.status, result: result, created_at: job.created_at, completed_at: job.completed_at });
    }

    if (listMode) {
      var jobs = await env.DB.prepare(
        'SELECT id, status, mode, result, created_at, completed_at FROM scan_jobs WHERE student_id = ? ORDER BY created_at DESC LIMIT 20'
      ).bind(user.student_id).all();
      // Add preview info (grade, question snippet) without sending full result
      var jobList = (jobs.results || []).map(function(j) {
        var preview = {};
        if (j.result) {
          try {
            var parsed = JSON.parse(j.result);
            preview.grade = parsed.grade || '';
            preview.score = parsed.score_estimate || 0;
            preview.question = (parsed.question_text || '').substring(0, 60);
          } catch (e) {}
        }
        return { id: j.id, status: j.status, mode: j.mode, created_at: j.created_at, preview: preview };
      });
      return jsonResponse({ jobs: jobList });
    }

    return jsonResponse({ error: 'Provide job_id or list=1' }, 400);
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  var user = await authenticate(request, env);

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return jsonResponse({ error: 'Messages array required' }, 400);
  }

  var mode = body.mode || 'standard';
  var model = body.model || 'claude-haiku-4-5-20251001';

  // Force model based on mode
  if (mode === 'express') model = 'claude-sonnet-4-20250514';
  else if (mode === 'standard' || mode === 'background') model = 'claude-haiku-4-5-20251001';

  // Background mode: process with Haiku, store result, return job ID
  if (mode === 'background') {
    if (!user) return jsonResponse({ error: 'Login required for background scans' }, 401);

    var jobId = 'SCAN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

    // Insert pending job
    await env.DB.prepare(
      'INSERT INTO scan_jobs (id, student_id, status, mode, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).bind(jobId, user.student_id, 'processing', mode).run();

    // Process in background using waitUntil so we can return immediately
    context.waitUntil(processBackgroundJob(env, jobId, user.student_id, model, body));

    return jsonResponse({ job_id: jobId, status: 'processing', message: 'Your scan is being analysed. Check back shortly.' });
  }

  // Express / Standard: process immediately
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  var jobId = 'SCAN-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();

  var anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: body.max_tokens || 4000,
      messages: body.messages
    })
  });
  var result = await anthropicResponse.json();
  var status = anthropicResponse.status;

  // Ensure valid JSON in response
  result = normalizeResult(result);

  // Save full result to scan_jobs for all modes (so user can review later)
  if (user && result.content) {
    var resultText = '';
    for (var i = 0; i < result.content.length; i++) {
      if (result.content[i].type === 'text') resultText += result.content[i].text;
    }
    try {
      await env.DB.prepare(
        'INSERT INTO scan_jobs (id, student_id, status, mode, result, created_at, completed_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)'
      ).bind(jobId, user.student_id, 'done', mode, resultText).run();
    } catch (e) {}
    saveScanResult(env, user.student_id, result);
  }

  return new Response(JSON.stringify(result), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

async function processBackgroundJob(env, jobId, studentId, model, body) {
  try {
    var anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model,
        max_tokens: body.max_tokens || 4000,
        messages: body.messages
      })
    });
    var result = await anthropicResponse.json();
    result = normalizeResult(result);

    // Extract JSON text from result
    var resultText = '';
    if (result.content) {
      for (var i = 0; i < result.content.length; i++) {
        if (result.content[i].type === 'text') resultText += result.content[i].text;
      }
    }

    await env.DB.prepare(
      'UPDATE scan_jobs SET status = ?, result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind('done', resultText, jobId).run();

    saveScanResult(env, studentId, result);
  } catch (e) {
    await env.DB.prepare(
      'UPDATE scan_jobs SET status = ?, result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind('failed', JSON.stringify({ error: e.message }), jobId).run();
  }
}

function normalizeResult(result) {
  if (result.content && result.content.length > 0) {
    var rawText = '';
    for (var m = 0; m < result.content.length; m++) {
      if (result.content[m].type === 'text') rawText += result.content[m].text;
    }
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    var parsed = null;
    try { parsed = JSON.parse(rawText); } catch (e) {}

    if (!parsed) {
      parsed = {
        question_text: 'Question from uploaded photo',
        parts: [],
        student_working: '',
        correct_answers: {},
        student_answers: {},
        score_estimate: 50,
        grade: 'C',
        errors: [],
        correct_method: [{
          step_number: 1,
          step_title: 'AI Analysis',
          step_explanation: rawText.substring(0, 2000),
          calculation: '',
          bar_model_description: ''
        }],
        key_concepts: ['Review the AI analysis above'],
        encouragement: 'Keep practising! Upload another paper to get more feedback.',
        xp_earned: 30
      };
    }

    result.content = [{ type: 'text', text: JSON.stringify(parsed) }];
  }
  return result;
}

function saveScanResult(env, studentId, result) {
  try {
    var text = '';
    for (var k = 0; k < result.content.length; k++) {
      if (result.content[k].type === 'text') text += result.content[k].text;
    }
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed = JSON.parse(text);
    env.DB.prepare(
      'INSERT INTO scan_results (student_id, question_text, grade, score_pct, errors_count, xp_earned) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(studentId, parsed.question_text || '', parsed.grade || '', parsed.score_estimate || 0, (parsed.errors || []).length, parsed.xp_earned || 0).run();
  } catch (e) {}
}

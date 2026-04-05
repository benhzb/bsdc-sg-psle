import { authenticate, jsonResponse, handleOptions } from './_helpers.js';

export async function onRequest(context) {
  var { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  // Auth is optional for scan — allow unauthenticated users to try it
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

  // Proxy to Anthropic API
  var anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: body.max_tokens || 4000,
      messages: body.messages
    })
  });

  var result = await anthropicResponse.json();

  // If authenticated, save scan result to DB
  if (user && result.content) {
    try {
      var text = '';
      for (var i = 0; i < result.content.length; i++) {
        if (result.content[i].type === 'text') text += result.content[i].text;
      }
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      var parsed = JSON.parse(text);

      await env.DB.prepare(
        'INSERT INTO scan_results (student_id, question_text, grade, score_pct, errors_count, xp_earned) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        user.student_id,
        parsed.question_text || '',
        parsed.grade || '',
        parsed.score_estimate || 0,
        (parsed.errors || []).length,
        parsed.xp_earned || 0
      ).run();
    } catch (e) {
      // Don't fail the response if DB save fails
    }
  }

  return new Response(JSON.stringify(result), {
    status: anthropicResponse.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

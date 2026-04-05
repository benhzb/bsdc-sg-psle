import { authenticate, jsonResponse, handleOptions } from './_helpers.js';

// Cloudflare AI REST API endpoint
var CF_AI_URL = 'https://api.cloudflare.com/client/v4/accounts/1608df142a7ce09054aa80a1e5dee8ff/ai/run/@cf/meta/llama-3.2-11b-vision-instruct';

export async function onRequest(context) {
  var { request, env } = context;

  if (request.method === 'OPTIONS') return handleOptions();
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

  var result;
  var status = 200;

  // Option 1: Anthropic API (if key configured)
  if (env.ANTHROPIC_API_KEY) {
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
    result = await anthropicResponse.json();
    status = anthropicResponse.status;

  // Option 2: Workers AI binding
  } else if (env.AI) {
    try {
      var msgs = buildAIMessages(body.messages);
      var aiResult = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        messages: msgs,
        max_tokens: 4000
      });
      result = { content: [{ type: 'text', text: aiResult.response || JSON.stringify(aiResult) }] };
    } catch (aiErr) {
      result = { error: { type: 'ai_error', message: aiErr.message } };
      status = 500;
    }

  // Option 3: Cloudflare AI REST API (using CF API Token)
  } else if (env.CF_API_TOKEN) {
    try {
      var msgs2 = buildAIMessages(body.messages);
      var cfResp = await fetch(CF_AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.CF_API_TOKEN
        },
        body: JSON.stringify({ messages: msgs2, max_tokens: 4000 })
      });
      var cfResult = await cfResp.json();
      if (cfResult.success && cfResult.result) {
        result = { content: [{ type: 'text', text: cfResult.result.response || JSON.stringify(cfResult.result) }] };
      } else {
        result = { error: { type: 'ai_error', message: JSON.stringify(cfResult.errors || cfResult) } };
        status = 500;
      }
    } catch (cfErr) {
      result = { error: { type: 'ai_error', message: cfErr.message } };
      status = 500;
    }

  } else {
    return jsonResponse({ error: 'No AI provider configured' }, 500);
  }

  // Save scan result to DB if authenticated
  if (user && result.content) {
    try {
      var text = '';
      for (var k = 0; k < result.content.length; k++) {
        if (result.content[k].type === 'text') text += result.content[k].text;
      }
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      var parsed = JSON.parse(text);
      await env.DB.prepare(
        'INSERT INTO scan_results (student_id, question_text, grade, score_pct, errors_count, xp_earned) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(user.student_id, parsed.question_text || '', parsed.grade || '', parsed.score_estimate || 0, (parsed.errors || []).length, parsed.xp_earned || 0).run();
    } catch (e) {}
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

function buildAIMessages(messages) {
  var userContent = messages[0].content;
  var promptText = '';
  var imageData = [];

  for (var i = 0; i < userContent.length; i++) {
    if (userContent[i].type === 'text') promptText = userContent[i].text;
    else if (userContent[i].type === 'image') imageData.push(userContent[i].source);
  }

  if (imageData.length > 0) {
    var parts = [];
    for (var j = 0; j < imageData.length; j++) {
      parts.push({
        type: 'image_url',
        image_url: {
          url: 'data:' + imageData[j].media_type + ';base64,' + imageData[j].data
        }
      });
    }
    parts.push({ type: 'text', text: promptText });
    return [{ role: 'user', content: parts }];
  }
  return [{ role: 'user', content: promptText }];
}

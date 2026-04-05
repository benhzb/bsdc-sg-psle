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

  var result;
  var status = 200;

  // Try Anthropic API first (if key configured), fallback to Workers AI
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
  } else if (env.AI) {
    // Use Cloudflare Workers AI
    try {
      // Extract text and images from the messages
      var userContent = body.messages[0].content;
      var promptText = '';
      var imageData = [];

      for (var i = 0; i < userContent.length; i++) {
        if (userContent[i].type === 'text') {
          promptText = userContent[i].text;
        } else if (userContent[i].type === 'image') {
          imageData.push(userContent[i].source);
        }
      }

      // Workers AI with vision model
      var aiMessages = [];

      if (imageData.length > 0) {
        // Build content array with images for vision model
        var contentParts = [];
        for (var j = 0; j < imageData.length; j++) {
          contentParts.push({
            type: 'image',
            image: 'data:' + imageData[j].media_type + ';base64,' + imageData[j].data
          });
        }
        contentParts.push({ type: 'text', text: promptText });
        aiMessages.push({ role: 'user', content: contentParts });
      } else {
        aiMessages.push({ role: 'user', content: promptText });
      }

      var aiResult = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        messages: aiMessages,
        max_tokens: 4000
      });

      // Format response to match Anthropic's structure
      result = {
        content: [{ type: 'text', text: aiResult.response || JSON.stringify(aiResult) }]
      };
    } catch (aiErr) {
      result = { error: { type: 'ai_error', message: aiErr.message || 'Workers AI failed' } };
      status = 500;
    }
  } else {
    return jsonResponse({ error: 'No AI provider configured. Set ANTHROPIC_API_KEY or enable Workers AI binding.' }, 500);
  }

  // If authenticated, save scan result to DB
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
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

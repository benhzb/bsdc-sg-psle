// Shared helpers for D-Wolf PSLE API
// This file is NOT routed (underscore prefix) — imported by other functions

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// SHA-256 hash for PIN storage
export async function hashPin(pin) {
  var data = new TextEncoder().encode(pin);
  var hash = await crypto.subtle.digest('SHA-256', data);
  var bytes = new Uint8Array(hash);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// JWT using Web Crypto HMAC-SHA256
export async function createJWT(payload, secret) {
  var header = { alg: 'HS256', typ: 'JWT' };
  var now = Math.floor(Date.now() / 1000);
  payload.iat = now;
  payload.exp = now + 30 * 24 * 60 * 60; // 30 days

  var enc = new TextEncoder();
  var headerB64 = base64url(JSON.stringify(header));
  var payloadB64 = base64url(JSON.stringify(payload));
  var signingInput = headerB64 + '.' + payloadB64;

  var key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  var sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  var sigB64 = base64url(String.fromCharCode.apply(null, new Uint8Array(sig)));

  return signingInput + '.' + sigB64;
}

export async function verifyJWT(token, secret) {
  var parts = token.split('.');
  if (parts.length !== 3) return null;

  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  var signingInput = parts[0] + '.' + parts[1];
  var sigBytes = base64urlDecode(parts[2]);
  var valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(signingInput));
  if (!valid) return null;

  var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

// Auth middleware: extracts student_id from Bearer token
export async function authenticate(request, env) {
  var authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  var token = authHeader.slice(7);
  var payload = await verifyJWT(token, env.JWT_SECRET);
  return payload; // { student_id, name } or null
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  var binary = atob(str);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Vercel Edge Function — calls Claude API and streams response back
// Deploys automatically when committed to /api/ask.js in your repo
// Required env var: ANTHROPIC_API_KEY (set in Vercel dashboard → Settings → Environment Variables)

export const config = {
  runtime: 'edge',
};

// Simple in-memory rate limiter — resets per cold start, but combined with
// Anthropic console spend cap it's good enough for civic tool scale.
const rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 15; // 15 requests per IP per hour

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now - entry.resetAt > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { count: 1, resetAt: now });
    return { ok: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt + RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }

  entry.count++;
  return { ok: true, remaining: RATE_LIMIT_MAX - entry.count };
}

// System prompt — defines Claude's behavior for this tool
const SYSTEM_PROMPT = `You are a helpful assistant for residents of Hawaiʻi using the 808 Housing tool — a free civic tool that helps people find housing programs they may qualify for.

Your job: respond in plain, simple language to questions about Hawaiʻi housing programs based on the user's situation. Be specific to Hawaiʻi. Be honest about realistic waitlist times and likelihood of success.

Style:
- Write at a reading level accessible to anyone — no bureaucratic jargon
- Use short sentences and short paragraphs
- Use markdown lightly — bold for key actions, simple bullet lists when appropriate
- No emoji
- Don't repeat the user's situation back at them — they know
- Be concrete: "call 808-768-3799" not "contact the agency"
- If you don't know something specific, say so — don't make up program details

What you know:
- All Hawaiʻi housing programs (Section 8, LIHTC, DHHL, HHFDC, county workforce housing, VA, USDA 502, kuleana exemptions, senior property tax exemptions, FEMA Maui recovery, Section 184A, etc.)
- HUD AMI brackets and their meaning
- Realistic waitlist times — be honest. DHHL averages 23 years. Section 8 waitlists close most years.
- Hawaiʻi-specific terminology (kupuna, ʻohana, kuleana, ʻōlelo)

Important:
- Always emphasize that program rules change and the user should verify with the listed agency
- Never promise approval or specific outcomes
- For DHHL: ~30,000 on the waitlist, 2,100+ have died waiting — be honest
- For Maui fire survivors: FEMA Direct Housing extends to Feb 28, 2027 (final extension)
- For Section 8: waitlists are mostly closed; mention the State Rent Supplement Program as a fallback
- This is informational, not legal or financial advice

Keep responses focused and brief — typically 200-400 words. The user is on a phone, possibly stressed, possibly low literacy. Respect their time.`;

export default async function handler(req) {
  // CORS for same-origin only — no cross-domain abuse
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Get IP for rate limiting
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || req.headers.get('x-real-ip')
          || 'unknown';

  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return new Response(
      JSON.stringify({
        error: 'Too many requests. Please wait a bit and try again.',
        retryAfter: limit.retryAfter
      }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(limit.retryAfter) }
      }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { situation, question, eligible_programs } = body;

  // Validate inputs
  if (!situation || !question) {
    return new Response(JSON.stringify({ error: 'Missing situation or question' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (situation.length > 2000 || question.length > 500) {
    return new Response(JSON.stringify({ error: 'Input too long' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Build the user message
  let userMessage = `My situation:\n${situation}\n\n`;
  if (eligible_programs && eligible_programs.length > 0) {
    userMessage += `Programs I appear to qualify for:\n${eligible_programs}\n\n`;
  }
  userMessage += `My question: ${question}`;

  try {
    // Call Anthropic API with streaming
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!anthropicResponse.ok) {
      const err = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, err);
      return new Response(
        JSON.stringify({ error: 'AI service unavailable. Please try again in a moment.' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Transform Anthropic SSE stream into a simpler text stream for the browser
    const reader = anthropicResponse.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);
                if (parsed.type === 'content_block_delta' &&
                    parsed.delta?.type === 'text_delta') {
                  controller.enqueue(encoder.encode(parsed.delta.text));
                }
              } catch (e) {
                // ignore parse errors on partial chunks
              }
            }
          }
        } catch (e) {
          console.error('Stream error:', e);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-RateLimit-Remaining': String(limit.remaining)
      }
    });

  } catch (e) {
    console.error('Handler error:', e);
    return new Response(
      JSON.stringify({ error: 'Something went wrong. Please try again.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

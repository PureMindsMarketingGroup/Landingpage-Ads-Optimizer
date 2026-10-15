/**
 * POST /api/analyze
 *
 * Backend-proxy tussen de browser en de Anthropic Messages API.
 * Hier — en alleen hier — leeft de API-key (omgevingsvariabele ANTHROPIC_API_KEY).
 *
 * De function:
 *   1. controleert het optionele wachtwoord (APP_PASSWORD) en een simpele rate limit;
 *   2. haalt de landingspagina op als er een URL is ingevuld i.p.v. losse tekst, en zet
 *      de HTML om naar schone tekst met structuurmarkeringen (zie _lib/scrape.js);
 *   3. stuurt alles naar Claude met de system prompt uit SYSTEM_PROMPT (Vercel;
 *      lokaal mag hij ook in CLAUDE.md staan);
 *   4. streamt het rapport regel voor regel terug naar de browser.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLandingpage, logPageText } from './_lib/scrape.js';

// --- Instellingen ------------------------------------------------------------

const MODEL = 'claude-opus-5';

/**
 * Hoe diep het model nadenkt. Op 'medium' duurt een analyse ongeveer twee minuten
 * en levert die een rapport van rond de 2.500 woorden — ruim binnen de 300 seconden
 * die Vercel een function geeft. 'high' gaat dieper maar kost navenant meer tijd
 * en tokens; 'low' is merkbaar sneller en oppervlakkiger.
 */
const EFFORT = 'medium';

/**
 * Een volledig rapport kwam in de praktijk uit op bijna 8.000 tokens. 16.000 geeft
 * genoeg marge zodat een uitgebreide analyse nooit halverwege afbreekt; ongebruikte
 * ruimte kost niets.
 */
const MAX_TOKENS = 16_000;

const MAX_FIELD_CHARS = 60_000;   // per invoerveld, beschermt tegen per ongeluk een heel boek plakken

// Best-effort rate limit. Serverless draait meerdere instances, dus dit is geen
// harde garantie — het vangt vooral per ongeluk dubbelklikken en losgeslagen scripts.
// Zet daarnaast altijd een maandlimiet op je API-key in de Anthropic Console.
const RATE_LIMIT_MAX = 12;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const recentRequests = new Map();

// --- System prompt -------------------------------------------------------------

let cachedSystemPrompt = null;

/**
 * De instructieset voor het model. Die staat bewust niet in deze (openbare) repo:
 * zet hem in Vercel als omgevingsvariabele SYSTEM_PROMPT (Settings -> Environment
 * Variables). Lokaal mag hij ook in CLAUDE.md staan, onder de kop "## System Prompt";
 * de projectcontext erboven is documentatie, niet voor het model.
 */
function getSystemPrompt() {
  if (cachedSystemPrompt) return cachedSystemPrompt;

  const fromEnv = (process.env.SYSTEM_PROMPT || '').trim();
  if (fromEnv) {
    cachedSystemPrompt = fromEnv;
    return cachedSystemPrompt;
  }

  // Lazy: het tweede pad kan zelf al gooien in omgevingen waar import.meta.url
  // geen bestandspad is. Dat mag het eerste pad niet meeslepen.
  const candidates = [
    () => join(process.cwd(), 'CLAUDE.md'),
    () => fileURLToPath(new URL('../CLAUDE.md', import.meta.url)),
  ];

  let raw = null;
  for (const resolvePath of candidates) {
    try {
      raw = readFileSync(resolvePath(), 'utf-8');
      break;
    } catch {
      // volgende kandidaat proberen
    }
  }

  if (!raw) {
    throw new Error('SYSTEM_PROMPT is niet ingesteld op de server. Zet de prompt in Vercel onder Settings → Environment Variables.');
  }

  const marker = raw.indexOf('## System Prompt');
  cachedSystemPrompt = marker === -1 ? raw.trim() : raw.slice(marker).trim();
  return cachedSystemPrompt;
}

// --- Rate limit ---------------------------------------------------------------

function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'onbekend';
}

function withinRateLimit(key) {
  const now = Date.now();
  const timestamps = (recentRequests.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    recentRequests.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  recentRequests.set(key, timestamps);
  return true;
}

// --- Handler ------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Alleen POST wordt ondersteund.' });
    return;
  }

  // Wachtwoord is optioneel: staat APP_PASSWORD niet ingesteld, dan is de tool open.
  const requiredPassword = process.env.APP_PASSWORD;
  if (requiredPassword) {
    const given = req.headers['x-app-password'];
    if (given !== requiredPassword) {
      res.status(401).json({ error: 'Onjuist wachtwoord.', code: 'auth_required' });
      return;
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is niet ingesteld op de server.' });
    return;
  }

  if (!withinRateLimit(clientKey(req))) {
    res.status(429).json({ error: 'Te veel aanvragen achter elkaar. Probeer het over een paar minuten opnieuw.' });
    return;
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  const landingpage = String(body?.landingpage ?? '').trim();
  const adsData = String(body?.adsData ?? '').trim();
  const conversionGoal = String(body?.conversionGoal ?? '').trim();

  if (!landingpage || !adsData || !conversionGoal) {
    res.status(400).json({ error: 'Landingspagina, Google Ads gegevens en conversiedoel zijn alle drie verplicht.' });
    return;
  }

  if (landingpage.length > MAX_FIELD_CHARS || adsData.length > MAX_FIELD_CHARS || conversionGoal.length > 500) {
    res.status(413).json({ error: 'De invoer is te lang. Kort de landingspagina-content in.' });
    return;
  }

  let systemPrompt;
  try {
    systemPrompt = getSystemPrompt();
  } catch (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const page = await resolveLandingpage(landingpage);
  // Precies wat het model te zien krijgt; handig om te controleren wat de scraper eruit haalt.
  logPageText(page);

  const userMessage = [
    `# Landingspagina (${page.source})`,
    page.text,
    '---',
    '# Google Ads gegevens',
    adsData,
    '---',
    '# Conversiedoel',
    conversionGoal,
  ].join('\n\n');

  const client = new Anthropic(); // leest ANTHROPIC_API_KEY uit de omgeving

  // Streamen: het rapport is lang, en de marketeer ziet zo direct dat er iets gebeurt
  // in plaats van 40 seconden naar een spinner te kijken.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // cache_control: de system prompt is bij elke aanvraag identiek, dus na de eerste
  // analyse rekent Anthropic dit deel tegen een lager tarief af.
  const request = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT },
    messages: [{ role: 'user', content: userMessage }],
  };

  let wroteOutput = false;
  const startedAt = Date.now();

  /**
   * Start de stream en schrijft elke tekstchunk direct door naar de browser.
   *
   * useFallback voegt de server-side fallback toe: weigert het model een aanvraag
   * (zeldzaam bij CRO-analyses), dan handelt Anthropic dat af op een ander model
   * in plaats van een lege respons terug te geven. Die beta staat niet op elk
   * account aan — vandaar de retry hieronder.
   */
  const runStream = async (useFallback) => {
    const stream = useFallback
      ? client.beta.messages.stream({
          ...request,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
      : client.messages.stream(request);

    stream.on('text', (chunk) => {
      wroteOutput = true;
      res.write(chunk);
    });

    return stream.finalMessage();
  };

  try {
    let finalMessage;
    try {
      finalMessage = await runStream(true);
    } catch (error) {
      // Accepteert het account de fallback-beta niet, dan draaien we dezelfde
      // aanvraag gewoon zonder. Alleen veilig zolang er nog niets verstuurd is.
      const rejectedBeta = error?.status === 400 && /beta|fallback/i.test(error?.message || '');
      if (!rejectedBeta || wroteOutput) throw error;
      console.warn('Server-side fallback niet beschikbaar, opnieuw zonder.');
      finalMessage = await runStream(false);
    }

    // Verschijnt in Vercel onder Deployments -> Functions -> Logs. Handig om te zien
    // wat een analyse kost en hoe dicht je tegen de time-out aan zit.
    console.log(
      'Analyse afgerond:',
      JSON.stringify({
        seconden: Math.round((Date.now() - startedAt) / 100) / 10,
        stop_reason: finalMessage.stop_reason,
        input_tokens: finalMessage.usage?.input_tokens,
        output_tokens: finalMessage.usage?.output_tokens,
        cache_geschreven: finalMessage.usage?.cache_creation_input_tokens,
        cache_gelezen: finalMessage.usage?.cache_read_input_tokens,
        pagina: page.source,
      })
    );

    if (finalMessage.stop_reason === 'refusal') {
      res.write('\n\n---\n\n**Let op:** de analyse is geweigerd door het model. Controleer de invoer op gevoelige of ongebruikelijke content.');
    } else if (finalMessage.stop_reason === 'max_tokens') {
      res.write('\n\n---\n\n**Let op:** het rapport is afgekapt omdat het maximum aantal tokens is bereikt. Kort de landingspagina-content in of verhoog `max_tokens` in `api/analyze.js`.');
    }

    res.end();
  } catch (error) {
    console.error('Analyse mislukt:', error);
    const message = error?.status === 401
      ? 'De API-key wordt geweigerd. Controleer ANTHROPIC_API_KEY.'
      : error?.status === 429
        ? 'Anthropic heeft een rate limit bereikt. Probeer het zo opnieuw.'
        : error?.message || 'Onbekende fout.';

    if (res.headersSent) {
      res.write(`\n\n---\n\n**Fout tijdens het genereren:** ${message}`);
      res.end();
    } else {
      res.status(502).json({ error: message });
    }
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

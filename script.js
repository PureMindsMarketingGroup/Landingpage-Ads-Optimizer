/**
 * Landingpage & Ads Optimizer - frontend logica
 *
 * Praat met /api/analyze (zie api/analyze.js). Die function houdt de API-key
 * server-side en streamt het rapport terug; hier zetten we die stroom Markdown
 * live om naar een opgemaakt document (zie report.js).
 */

const form = document.getElementById('optimizer-form');
const output = document.getElementById('report-output');
const placeholder = document.getElementById('report-placeholder');
const reportCard = document.getElementById('report-card');
const reportScroll = document.getElementById('report-scroll');
const submitBtn = document.getElementById('submit-btn');
const submitLabel = document.getElementById('submit-label');
const submitSpinner = document.getElementById('submit-spinner');
const submitArrow = document.getElementById('submit-arrow');
const statusBadge = document.getElementById('status-badge');
const progress = document.getElementById('progress');
const scores = document.getElementById('scores');
const docsBtn = document.getElementById('docs-btn');
const wordBtn = document.getElementById('word-btn');
const pdfBtn = document.getElementById('pdf-btn');
const docsPopover = document.getElementById('docs-popover');
const resetBtn = document.getElementById('reset-btn');
const landingpageHint = document.getElementById('landingpage-hint');

const passwordOverlay = document.getElementById('password-overlay');
const passwordForm = document.getElementById('password-form');
const passwordInput = document.getElementById('password-input');
const passwordError = document.getElementById('password-error');

const FIELDS = ['landingpage', 'ads-data', 'conversion-goal'].map((id) => document.getElementById(id));
const EXPORT_BUTTONS = [docsBtn, wordBtn, pdfBtn];

const STORAGE = {
  password: 'cro-optimizer-password',
  draft: 'cro-optimizer-draft',
  report: 'cro-optimizer-report',
  reportMeta: 'cro-optimizer-report-meta',
  reportDate: 'cro-optimizer-report-date', // oude opslag: alleen de datum, nog leesbaar
};

/** Zelfde herkenning als in api/analyze.js, zodat de hint klopt met wat de server doet. */
const URL_PATTERN = /^(https?:\/\/\S+|([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?)$/i;
const LANDINGPAGE_HINT = landingpageHint.textContent;

/** Laatst gegenereerde rapport (ruwe Markdown), voor exporteren en herstellen. */
let lastReport = '';

/** Gegevens voor de documentkop: datum, landingspagina en conversiedoel van dat rapport. */
let reportMeta = null;

/** Onthouden wachtwoord, alleen nodig als de server APP_PASSWORD heeft ingesteld. */
let appPassword = storageGet(STORAGE.password) || '';

let isLoading = false;
let timer = null;

// --- Formulier ---------------------------------------------------------------

form.addEventListener('submit', async (event) => {
  // Voorkomt dat de pagina refresht bij submit.
  event.preventDefault();
  if (isLoading) return;

  const data = {
    landingpage: FIELDS[0].value.trim(),
    adsData: FIELDS[1].value.trim(),
    conversionGoal: FIELDS[2].value.trim(),
  };

  if (!data.landingpage || !data.adsData || !data.conversionGoal) {
    renderError('Vul alle drie de velden in voordat je een briefing genereert.');
    return;
  }

  setLoading(true);
  lastReport = '';
  reportMeta = {
    generatedAt: Date.now(),
    landingpage: URL_PATTERN.test(data.landingpage) ? data.landingpage : 'Geplakte paginatekst',
    conversionGoal: data.conversionGoal,
  };
  showWaiting();
  reportScroll.scrollTop = 0;

  // Op mobiel staat het rapport onder het formulier: breng het in beeld.
  if (!isDesktop()) {
    reportCard.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
  }

  const startedAt = Date.now();
  try {
    await fetchClaudeAnalysis(data);
    storageSet(STORAGE.report, lastReport);
    storageSet(STORAGE.reportMeta, JSON.stringify(reportMeta));
    storageRemove(STORAGE.reportDate);
    setStatus('done', `Klaar in ${formatDuration(Date.now() - startedAt)}`);
  } catch (error) {
    if (error.code === 'auth_required') {
      askForPassword(error.message);
      resetReport();
    } else {
      console.error(error);
      renderError(error.message || 'Er ging iets mis bij het genereren van de briefing.');
    }
  } finally {
    setLoading(false);
  }
});

/**
 * Vraagt de CRO-analyse op bij de backend en rendert de stream live.
 *
 * @param {{landingpage: string, adsData: string, conversionGoal: string}} data
 */
async function fetchClaudeAnalysis(data) {
  const headers = { 'Content-Type': 'application/json' };
  if (appPassword) headers['X-App-Password'] = appPassword;

  let response;
  try {
    response = await fetch('/api/analyze', {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });
  } catch {
    throw new Error('Geen verbinding met de server. Controleer je internetverbinding en probeer het opnieuw.');
  }

  if (!response.ok) {
    // Foutmeldingen komen als JSON terug; het rapport zelf als platte-tekststream.
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    const error = new Error(payload.error || `Analyse mislukt (HTTP ${response.status}).`);
    error.code = payload.code;
    throw error;
  }

  // Vanaf hier stroomt het rapport binnen.
  document.body.classList.add('streaming');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = false;

  // Renderen bij elke chunk is zonde van de CPU; we hertekenen maximaal per frame.
  const scheduleRender = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      renderReport(lastReport, { streaming: true });
    });
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastReport += decoder.decode(value, { stream: true });
      scheduleRender();
    }
  } finally {
    document.body.classList.remove('streaming');
  }

  renderReport(lastReport, { streaming: false });
}

// --- Rapport renderen ---------------------------------------------------------

/** Rendert het document en werkt voortgang, scores en knoppen bij. */
function renderReport(markdown, { streaming }) {
  // Meelezen tijdens het schrijven, zoals in een chat: wie zelf omhoog scrolt, wordt niet teruggetrokken.
  const follow = streaming && isDesktop() &&
    reportScroll.scrollHeight - reportScroll.scrollTop - reportScroll.clientHeight < 80;

  placeholder.classList.add('hidden');
  output.classList.remove('hidden');
  Report.renderDocument(output, markdown, reportMeta);

  updateProgress(markdown, streaming);
  updateScores(markdown);

  const hasReport = !streaming && markdown.trim().length > 0;
  EXPORT_BUTTONS.forEach((button) => button.classList.toggle('hidden', !hasReport));
  if (!hasReport) closeDocsPopover();

  if (follow) reportScroll.scrollTop = reportScroll.scrollHeight;
}

/** Desktop = twee kolommen waarin het rapport binnen de kaart scrolt. */
function isDesktop() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

// Afgeronde stappen springen naar hun sectie in het rapport.
progress.addEventListener('click', (event) => {
  const step = event.target.closest('.step');
  if (!step || step.dataset.state !== 'done') return;
  const heading = output.querySelectorAll('.doc-body h2')[Number(step.dataset.step) - 1];
  heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/** Stap = aantal "## "-secties dat binnen is. Tijdens het streamen is de laatste nog bezig. */
function updateProgress(markdown, streaming) {
  const sections = (markdown.match(/^## /gm) || []).length;
  progress.classList.remove('hidden');
  progress.querySelectorAll('.step').forEach((step) => {
    const n = Number(step.dataset.step);
    let state = 'todo';
    if (!streaming || n < sections) state = 'done';
    else if (n === Math.max(sections, 1)) state = 'active';
    step.dataset.state = state;
  });
  if (streaming) {
    setStatus('busy', `Stap ${Math.min(Math.max(sections, 1), 4)} van 4`);
  }
}

/** Toont de scores als labels in de kop van het rapport, altijd in beeld. */
function updateScores(markdown) {
  const found = Report.extractScores(markdown);

  scores.classList.toggle('hidden', found.length === 0);
  scores.innerHTML = '';
  found.forEach(({ label, value }) => {
    const tone = Report.TONES[Report.scoreTone(value)];
    const pill = document.createElement('span');
    pill.className = 'inline-flex items-baseline gap-1.5 whitespace-nowrap px-2 py-0.5 text-xs';
    pill.style.cssText = `background:${tone.fill};color:${tone.text}`;
    pill.innerHTML = '<span class="opacity-80"></span><strong class="font-bold tabular-nums"></strong>';
    pill.firstChild.textContent = label;
    pill.lastChild.textContent = `${Report.formatScore(value)}/10`;
    scores.appendChild(pill);
  });
}

// --- Staten -------------------------------------------------------------------

function showEmpty() {
  placeholder.replaceChildren(document.getElementById('empty-state').content.cloneNode(true));
  placeholder.classList.remove('hidden');
  output.classList.add('hidden');
  output.replaceChildren();
}

function showWaiting() {
  placeholder.replaceChildren(document.getElementById('waiting-state').content.cloneNode(true));
  placeholder.classList.remove('hidden');
  output.classList.add('hidden');
  output.replaceChildren();
  scores.classList.add('hidden');
  EXPORT_BUTTONS.forEach((button) => button.classList.add('hidden'));
  closeDocsPopover();
  progress.classList.remove('hidden');
  progress.querySelectorAll('.step').forEach((step) => { step.dataset.state = step.dataset.step === '1' ? 'active' : 'todo'; });
  setStatus('busy', 'Pagina ophalen');
}

/** Terug naar de beginsituatie. */
function resetReport() {
  lastReport = '';
  reportMeta = null;
  storageRemove(STORAGE.report);
  storageRemove(STORAGE.reportMeta);
  storageRemove(STORAGE.reportDate);
  progress.classList.add('hidden');
  scores.classList.add('hidden');
  EXPORT_BUTTONS.forEach((button) => button.classList.add('hidden'));
  closeDocsPopover();
  setStatus(null);
  showEmpty();
}

/** Toont een foutmelding boven het document. Een half binnengekomen rapport blijft staan. */
function renderError(message) {
  const box = document.createElement('div');
  box.className = 'mx-auto mb-3 max-w-[50rem] border-l-4 border-pm-magenta bg-white px-4 py-3 text-sm font-semibold text-[#9e1744]';
  box.textContent = message;
  placeholder.replaceChildren(box);
  placeholder.classList.remove('hidden');
  progress.classList.add('hidden');

  if (lastReport) {
    renderReport(lastReport, { streaming: false });
    placeholder.classList.remove('hidden');
    progress.classList.add('hidden');
  } else {
    output.classList.add('hidden');
    scores.classList.add('hidden');
    EXPORT_BUTTONS.forEach((button) => button.classList.add('hidden'));
  }
  setStatus('error', 'Mislukt');
}

// --- Wachtwoord ---------------------------------------------------------------

function askForPassword(message) {
  passwordError.textContent = message || '';
  passwordError.classList.toggle('hidden', !message);
  passwordOverlay.classList.remove('hidden');
  passwordOverlay.classList.add('flex');
  passwordInput.focus();
}

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  appPassword = passwordInput.value;
  storageSet(STORAGE.password, appPassword);
  passwordOverlay.classList.add('hidden');
  passwordOverlay.classList.remove('flex');
  passwordInput.value = '';
  // Direct opnieuw proberen met het zojuist ingevoerde wachtwoord.
  form.requestSubmit();
});

// --- UI-helpers ---------------------------------------------------------------

/** Schakelt de loading-state van knop, reset en timer. */
function setLoading(loading) {
  isLoading = loading;
  submitBtn.disabled = loading;
  resetBtn.disabled = loading;
  submitLabel.textContent = loading ? 'bezig met analyseren…' : 'genereer CRO briefing';
  submitSpinner.classList.toggle('hidden', !loading);
  submitArrow.classList.toggle('hidden', loading);

  clearInterval(timer);
  if (loading) {
    const startedAt = Date.now();
    const tick = () => { submitLabel.textContent = `bezig met analyseren… ${formatDuration(Date.now() - startedAt)}`; };
    tick();
    timer = setInterval(tick, 1000);
  }
}

const STATUS_TONES = {
  busy: 'bg-pm-tint text-pm-blue',
  done: 'bg-[#e3f4ee] text-[#00704f]',
  error: 'bg-[#fbe8ee] text-[#9e1744]',
  saved: 'bg-[#eef2f5] text-pm-muted',
};

function setStatus(kind, text) {
  statusBadge.className = `px-2 py-0.5 text-xs font-semibold tabular-nums ${STATUS_TONES[kind] || ''}`;
  statusBadge.classList.toggle('hidden', !kind);
  statusBadge.textContent = text || '';
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Vinkje per ingevuld veld en een hint of de landingspagina als URL of als tekst wordt gelezen. */
function updateFieldState() {
  FIELDS.forEach((field) => {
    field.closest('.field').classList.toggle('is-filled', field.value.trim().length > 0);
  });

  const value = FIELDS[0].value.trim();
  if (!value) {
    landingpageHint.textContent = LANDINGPAGE_HINT;
    landingpageHint.className = 'mt-1.5 text-xs text-pm-muted';
  } else if (URL_PATTERN.test(value)) {
    landingpageHint.textContent = 'URL herkend: de tool haalt deze pagina zelf op.';
    landingpageHint.className = 'mt-1.5 text-xs font-semibold text-[#00704f]';
  } else if ((value.match(/<\/?[a-z][^>]*>/gi) || []).length >= 3) {
    landingpageHint.textContent = `HTML-broncode herkend (${value.length.toLocaleString('nl-NL')} tekens): de tool haalt de tekst eruit.`;
    landingpageHint.className = 'mt-1.5 text-xs font-semibold text-pm-blue';
  } else {
    landingpageHint.textContent = `Geplakte tekst herkend (${value.length.toLocaleString('nl-NL')} tekens).`;
    landingpageHint.className = 'mt-1.5 text-xs font-semibold text-pm-blue';
  }
}

form.addEventListener('input', () => {
  updateFieldState();
  storageSet(STORAGE.draft, JSON.stringify(FIELDS.map((field) => field.value)));
});

// --- Exporteren -----------------------------------------------------------------

/** Zet een exportknop in de wachtstand zolang het bestand gemaakt wordt. */
async function runExport(button, busyLabel, task) {
  const label = button.querySelector('span');
  const original = label.textContent;
  button.disabled = true;
  label.textContent = busyLabel;
  try {
    await task();
  } catch (error) {
    console.error(error);
    alert(error.message || 'Het bestand kon niet gemaakt worden.');
  } finally {
    button.disabled = false;
    label.textContent = original;
  }
}

pdfBtn.addEventListener('click', () => runExport(pdfBtn, 'pdf maken…', () =>
  downloadReportPdf({ markdown: lastReport, meta: reportMeta })));

wordBtn.addEventListener('click', () => runExport(wordBtn, 'word maken…', () =>
  downloadReportDocx({ markdown: lastReport, meta: reportMeta })));

// Google Docs: kopiëren met opmaak en daarna uitleggen waar je plakt. Een directe koppeling
// met Google Drive zou een Google-login en API-sleutel vragen; plakken werkt zonder.
docsBtn.addEventListener('click', async () => {
  if (!lastReport) return;
  const label = docsBtn.querySelector('span');
  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([Report.clipboardHtml(output)], { type: 'text/html' }),
          'text/plain': new Blob([lastReport], { type: 'text/plain' }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(lastReport);
    }
    openDocsPopover();
  } catch (error) {
    console.error(error);
    label.textContent = 'kopiëren mislukt';
    setTimeout(() => { label.textContent = 'google docs'; }, 2000);
  }
});

document.getElementById('paste-key').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function openDocsPopover() {
  docsPopover.classList.remove('hidden');
  document.getElementById('docs-link').focus();
}

function closeDocsPopover() {
  docsPopover.classList.add('hidden');
}

document.getElementById('docs-close').addEventListener('click', () => {
  closeDocsPopover();
  docsBtn.focus();
});
document.getElementById('docs-link').addEventListener('click', () => setTimeout(closeDocsPopover, 300));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !docsPopover.classList.contains('hidden')) {
    closeDocsPopover();
    docsBtn.focus();
  }
});
document.addEventListener('click', (event) => {
  if (!docsPopover.contains(event.target) && !docsBtn.contains(event.target)) closeDocsPopover();
});

resetBtn.addEventListener('click', (event) => {
  if (lastReport && !confirm('Invoer én rapport wissen? Dit kun je niet ongedaan maken.')) {
    event.preventDefault();
    return;
  }
  storageRemove(STORAGE.draft);
  resetReport();
  // Het native reset-event leegt de velden pas na deze handler.
  setTimeout(updateFieldState);
});

// --- Opslag -------------------------------------------------------------------
// Invoer en laatste rapport overleven een refresh: een analyse kost twee minuten en geld.

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* opslag vol of geblokkeerd */ }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* geblokkeerd */ }
}

(function restore() {
  try {
    const draft = JSON.parse(storageGet(STORAGE.draft) || '[]');
    FIELDS.forEach((field, i) => { if (typeof draft[i] === 'string') field.value = draft[i]; });
  } catch { /* ongeldige opslag negeren */ }
  updateFieldState();

  const saved = storageGet(STORAGE.report);
  if (saved) {
    try {
      reportMeta = JSON.parse(storageGet(STORAGE.reportMeta) || 'null');
    } catch { /* ongeldige opslag negeren */ }
    const savedAt = Number(storageGet(STORAGE.reportDate));
    if (!reportMeta && savedAt) reportMeta = { generatedAt: savedAt };

    lastReport = saved;
    renderReport(saved, { streaming: false });
    setStatus('saved', 'Vorige analyse');
  } else {
    showEmpty();
  }
})();

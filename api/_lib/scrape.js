/**
 * Landingspagina ophalen en omzetten naar schone tekst voor het model.
 *
 * Het model ziet geen pixels en geen CSS. Alles wat een bezoeker wél ziet maar niet als
 * lopende tekst in de HTML staat, benoemen we daarom expliciet tussen vierkante haken:
 * koppen ([H1]), afbeeldingen ([Afbeelding: alt-tekst]), formuliervelden
 * ([Veld: … (verplicht)]), knoppen, menu's en verborgen blokken. Wat een bezoeker níét
 * ziet (script, style, hidden, display:none) gaat eruit, en woorden die door inline-tags
 * of een zacht afbreekstreepje (&shy;) in stukken staan, plakken we weer aan elkaar.
 *
 * De HTML wordt gelezen met htmlparser2 (dezelfde parser als onder cheerio). Die verdraagt
 * slordige HTML en houdt de nesting bij, zodat een verborgen blok mét alles erin verdwijnt.
 * Met losse regexes lukt dat niet: die zien niet waar een blok eindigt.
 *
 * Dit bestand begint met een underscore, zodat Vercel er geen aparte function van maakt.
 */

import { Parser } from 'htmlparser2';

// --- Instellingen ------------------------------------------------------------

export const MAX_PAGE_CHARS = 40_000;  // maximum aan tekst dat we uit een pagina meenemen
const MAX_HTML_BYTES = 2_000_000;      // meer HTML lezen we niet; bescherming tegen reuzenpagina's
const FETCH_TIMEOUT_MS = 15_000;
const MIN_BODY_CHARS = 200;            // minder dan dit noemen we "nauwelijks tekst"
const MAX_NAV_ITEMS = 40;              // langere menu's kappen we af
const MIN_HIDDEN_CHARS = 60;           // kortere verborgen stukjes (schermlezertekst, tooltips) negeren we
const MAX_HIDDEN_MARKERS = 12;         // daarna tellen we verborgen blokken alleen nog
const MAX_NOALT_MARKERS = 30;          // idem voor afbeeldingen zonder alt-tekst
const MAX_SELECT_OPTIONS = 10;
const LOG_CHUNK_CHARS = 3_500;         // Vercel kapt lange logregels af; in stukken blijft alles leesbaar

// --- URL-herkenning ----------------------------------------------------------

/**
 * Herkent ook adressen zonder schema ("www.voorbeeld.nl/offerte"): marketeers
 * kopiëren die vaak zo uit een adresbalk of spreadsheet. Moet gelijk lopen met
 * dezelfde regex in script.js, die de gebruiker vooraf laat zien wat er gebeurt.
 */
const URL_PATTERN = /^(https?:\/\/\S+|([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?)$/i;

export function looksLikeUrl(value) {
  return URL_PATTERN.test(value.trim());
}

/** Geplakte broncode herkennen we aan een handvol echte HTML-tags. */
const HTML_TAG = /<\/?(?:html|head|body|div|p|span|h[1-6]|ul|ol|li|a|form|input|section|header|footer|main|nav|img|br|table|td)\b[^>]*>/gi;

export function looksLikeHtml(value) {
  return (value.match(HTML_TAG) || []).length >= 3;
}

function withScheme(value) {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Weigert adressen in het interne netwerk, zodat de proxy niet als scanner te misbruiken is. */
function isPublicHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (/^(127|10)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '::1' || host === '0.0.0.0') return false;
  return true;
}

// --- Elementen indelen ---------------------------------------------------------

/** Inhoud die een bezoeker nooit als tekst ziet. */
const SKIP_CONTENT = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'canvas',
  'audio', 'video', 'map', 'datalist', 'textarea',
]);

/**
 * Inline-elementen dragen zelf geen witruimte bij, precies zoals in een browser. Zo blijft
 * "Scha<span>ar</span>heftafel" één woord. Alle andere elementen gelden als blok en beginnen
 * op een nieuwe regel.
 */
const INLINE = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em',
  'font', 'i', 'ins', 'kbd', 'label', 'mark', 'nobr', 'output', 'picture', 'q', 'rp', 'rt',
  'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var',
]);

/** Lege elementen die niets bijdragen, ook geen witruimte. */
const SILENT = new Set(['wbr', 'source', 'track', 'area', 'col', 'colgroup', 'param', 'base', 'link']);

/** Na deze blokken hoort een witregel, zodat alinea's herkenbaar blijven. */
const PARAGRAPH = new Set([
  'p', 'blockquote', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure',
  'table', 'ul', 'ol', 'dl', 'form', 'fieldset', 'details', 'pre', 'div',
]);

const HEADING = /^h[1-6]$/;

/** Een <footer> of <aside> hierbinnen hoort bij een onderdeel, niet bij de pagina. */
const INNER_REGIONS = new Set(['main', 'article', 'section', 'aside', 'li', 'form']);

/** Wat in een menu, pop-up, zoekformulier of verborgen blok staat, telt niet mee in de structuursamenvatting. */
const UNCOUNTED = new Set(['nav', 'hidden', 'popup', 'cookie', 'search']);

/** Het zoekveld van de site is geen conversieformulier. */
const SEARCH_FORM = /(?:^|[\s_/?-])(?:search|zoek|zoeken)(?:[\s_/?=-]|$)/i;

/** "Ga naar de inhoud"-links staan voor schermlezers en toetsenbordgebruikers; geen menu-item. */
const SKIP_LINK = /^(?:skip to|ga naar|naar|direct naar|spring naar)\b|^(?:skip|inhoud|content)$/i;

/** Links die als knop zijn opgemaakt, herkennen we aan hun klasse (btn, button, cta). */
const BUTTON_CLASS = /(?:^|[\s_-])(?:btn|button|cta)(?:[\s_-]|$)/i;

/** Lijsten en blokken die een menu zijn zonder <nav>-tag: WordPress, Bootstrap, Elementor. */
const MENU_CLASS = /(?:^|[\s_-])(?:menu|nav|navigation|navbar)(?:[\s_-]|$)/i;

const FIELD_TYPES = {
  email: 'e-mail', tel: 'telefoon', number: 'getal', date: 'datum', 'datetime-local': 'datum en tijd',
  time: 'tijd', month: 'maand', week: 'week', url: 'URL', password: 'wachtwoord', search: 'zoeken',
  file: 'bestand', range: 'schuifregelaar', color: 'kleur',
};

/** Formulieren en widgets die pas door JavaScript worden ingeladen: onzichtbaar in de HTML. */
const JS_EMBEDS = [
  [/hsforms\.net|hubspot\.com\/.*forms|hbspt-form|hbspt\.forms/i, 'HubSpot-formulier'],
  [/typeform\.com|data-tf-|typeform-widget/i, 'Typeform-formulier'],
  [/jotform\.com|jotform-/i, 'JotForm-formulier'],
  [/calendly\.com|calendly-inline-widget/i, 'Calendly-afspraakplanner'],
  [/nf-form-\d|ninja-forms/i, 'Ninja Forms-formulier'],
  [/activehosted\.com|_form_\d+_/i, 'ActiveCampaign-formulier'],
  [/list-manage\.com|mc-embedded-subscribe/i, 'Mailchimp-formulier'],
];

/** Onzichtbare tekens: besturingstekens, zachte afbreekstreepjes en zero-width spaties. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Markering voor de grens van een inline-element. Aan het eind beslissen we per grens of er
 * een spatie hoort ("Home|Over ons": ja) of niet ("Scha|ar|heftafel": nee).
 */
const SOFT = '\u0002';
const SOFT_RE = /\u0002+/g;

// --- Verborgen elementen -------------------------------------------------------

const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i;

/** Klassen die altijd verbergen: Bootstrap, Foundation, Bulma, BEM-conventies. */
const ALWAYS_HIDDEN_CLASSES = new Set(['u-hidden', 'is-hidden', 'hide', 'visible-xs', 'visible-sm']);

/** "Alleen op mobiel": elementor-hidden-desktop, hidden-lg, hide-on-desktop, et_pb_hide_on_desktop … */
const DESKTOP_HIDDEN_CLASS = /^[a-z0-9_-]*hid(?:den|e)[-_]?(?:on[-_])?(?:desktop|large|lg|xl|xxl|md)$/;

/** display:none via een utility-klasse, tenzij een responsive klasse het op desktop weer toont. */
const TOGGLE_HIDDEN_CLASSES = new Set(['hidden', 'd-none']);
const SHOWN_ON_DESKTOP_CLASS = /^(?:(?:sm|md|lg|xl|2xl):(?:block|flex|grid|inline|inline-block|inline-flex|table|contents)|d-(?:sm|md|lg|xl|xxl)-(?:block|flex|grid|inline|inline-block|inline-flex|table))$/;

/** Tekst die alleen voor schermlezers bestaat en de zichtbare tekst herhaalt ("Ga naar de inhoud", kaarttitels). */
const SCREEN_READER_CLASSES = new Set(['sr-only', 'visually-hidden', 'visuallyhidden', 'screen-reader-text', 'screen-reader-only']);

function hiddenByClass(value) {
  const tokens = value.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => ALWAYS_HIDDEN_CLASSES.has(token) || DESKTOP_HIDDEN_CLASS.test(token))) return true;
  if (!tokens.some((token) => TOGGLE_HIDDEN_CLASSES.has(token))) return false;
  return !tokens.some((token) => SHOWN_ON_DESKTOP_CLASS.test(token));
}

/**
 * Ziet de bezoeker dit element? We kijken naar wat statisch in de HTML staat: het
 * hidden-attribuut, aria-hidden, een inline display:none en bekende verberg-klassen.
 * Stylesheets kunnen we niet lezen, dus dit is een ondergrens.
 *
 * @returns {null | 'screenreader' | 'hidden'} schermlezertekst laten we stilletjes weg;
 *   ander verborgen materiaal (tabbladen, modals, mobiele menu's) vatten we samen.
 */
function hiddenKind(name, attrs) {
  if (name === 'html' || name === 'body' || name === 'main') return null;
  const classes = (attrs.class || '').toLowerCase().split(/\s+/);
  if (classes.some((token) => SCREEN_READER_CLASSES.has(token))) return 'screenreader';
  if ('hidden' in attrs) return 'hidden';
  if (attrs['aria-hidden'] === 'true') return 'hidden';
  if (name === 'dialog' && !('open' in attrs)) return 'hidden';
  if (attrs.style && HIDDEN_STYLE.test(attrs.style)) return 'hidden';
  if (attrs.class && hiddenByClass(attrs.class)) return 'hidden';
  return null;
}

const REGION_TAGS = new Set(['div', 'section', 'aside', 'dialog', 'form']);
const COOKIE_CLASS = /^(?:cookie|cookies|cookie[-_]?(?:bar|banner|notice|consent|law|policy|wall|melding|popup|box)|cookieconsent|cc-window|cc-banner|gdpr(?:[-_][a-z]+)?|consent[-_](?:banner|bar|popup|modal|notice|management|box))$/;
const POPUP_CLASS = /^(?:modal|popup|pop-up|lightbox|elementor-popup-modal|pum-overlay|pum|exit-intent|newsletter-popup|mfp-wrap|fancybox-container|remodal|tingle-modal)$/;

/** Cookiemeldingen en pop-ups: samengevat tot één regel, zodat ze de body copy niet vervuilen. */
function specialRegion(name, attrs) {
  if (!REGION_TAGS.has(name)) return null;
  const tokens = `${attrs.id || ''} ${attrs.class || ''}`.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => COOKIE_CLASS.test(token))) return 'cookie';
  if (attrs.role === 'dialog' || attrs['aria-modal'] === 'true' || tokens.some((token) => POPUP_CLASS.test(token))) return 'popup';
  return null;
}

// --- Tekst opschonen -------------------------------------------------------------

const UPPER = /\p{Lu}/u;
const WORDISH = /[\p{L}\p{N}.,!?:;)"'»”’]/u;

/**
 * Beslist per inline-grens of er een spatie komt. Een hoofdletter erna wijst op een nieuw
 * woord of menu-item ("Home|Over ons", "SEO|SEA"); een kleine letter op een woord dat door
 * een tag in stukken is gehakt ("Scha|arheftafel"). Grenzen naast witruimte verdwijnen.
 */
function resolveBoundary(match, offset, text) {
  const prev = text[offset - 1];
  const next = text[offset + match.length];
  if (!prev || !next || /\s/.test(prev) || /\s/.test(next)) return '';
  if (UPPER.test(next) && WORDISH.test(prev)) return ' ';
  if (/[!?:;]/.test(prev) && /[\p{L}\p{N}]/u.test(next)) return ' ';
  return '';
}

function resolve(text) {
  return text.replace(SOFT_RE, resolveBoundary);
}

/** Eén regel: voor koppen, knoppen, labels en samenvattingen. */
function oneLine(text) {
  return resolve(text || '').replace(/\s+/g, ' ').trim();
}

/** Lopende tekst: witruimte normaliseren, regels met alleen opsommingstekens weg, maximaal één witregel. */
function normalizeBlock(text) {
  return resolve(text)
    .replace(/[ \t \r\f\v]+/g, ' ')
    // Hetzelfde logo drie keer achter elkaar (gewoon, retina, donker) is één logo.
    .replace(/(\[Afbeelding[^\]]*\])(?:\s+\1)+/g, '$1')
    .replace(/ *\n */g, '\n')
    .replace(/^(?:[-•·|][ \t]*)+$/gm, '')
    .replace(/(?: \|)+$/gm, '')
    .replace(/^\| /gm, '')
    .replace(/(?: \|){2,}/g, ' |')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Bestandsnaam van een afbeelding als leesbare tekst: "maastricht-university-logo-300x150.png" -> "maastricht university logo". */
function imageFileName(src) {
  if (!src || /^data:/i.test(src)) return '';
  let name = '';
  try {
    name = decodeURIComponent(new URL(src, 'https://x.invalid/').pathname.split('/').pop() || '');
  } catch {
    name = src.split(/[?#]/)[0].split('/').pop() || '';
  }
  name = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')      // extensie
    .replace(/-\d{2,4}x\d{2,4}$/i, '')     // WordPress-formaat: -300x150
    .replace(/@\dx$/i, '')                 // retina: @2x
    .split(/[-_+.\s]+/)
    // Nummers en hash-achtige codes (abc123, 3f9a8b7c) zeggen niets over het beeld.
    .filter((token) => token && !/^\d+$/.test(token) && !(token.length >= 6 && /\d/.test(token) && /[a-z]/i.test(token)))
    .join(' ');
  if ((name.match(/\p{L}/gu) || []).length < 3) return '';
  return truncate(name, 60);
}

const TRACKING_SRC = /facebook\.com\/tr|doubleclick|googleads|google-analytics|googletagmanager|\/pixel|pixel\.|beacon|\/track|spacer|blank\.gif|1x1|transparent\.(?:gif|png)/i;

function isRequired(attrs) {
  return 'required' in attrs
    || attrs['aria-required'] === 'true'
    || /(?:^|\s)(?:required|wpcf7-validates-as-required)(?:\s|$)/i.test(attrs.class || '');
}

// --- De extractie ------------------------------------------------------------------

/**
 * Luistert naar de parser en bouwt de tekst op. Een stapel van open elementen houdt bij
 * wat verborgen of overgeslagen is; "captures" vangen de tekst van een kop, knop, menu of
 * verborgen blok op, zodat die op het eind als één markering wordt uitgeschreven.
 */
class Extractor {
  constructor({ keepHidden = false } = {}) {
    this.keepHidden = keepHidden;
    this.stack = [];
    this.captures = [];
    this.out = [];
    this.skipDepth = 0;
    this.svgDepth = 0;
    this.hiddenDepth = 0;
    this.title = '';
    this.titleSeen = false;
    this.description = '';
    this.ogDescription = '';
    this.embedsSeen = new Set();
    this.stats = {
      headings: [0, 0, 0, 0, 0, 0, 0], images: 0, imagesNoAlt: 0, forms: 0, fields: 0, required: 0,
      buttons: 0, videos: 0, navs: 0, hidden: 0, hiddenMarkers: 0, hiddenChars: 0, popups: 0,
      cookies: 0, embeds: 0, duplicates: 0,
    };
  }

  // --- Uitvoer ---

  emit(text) {
    if (!text) return;
    const capture = this.captures[this.captures.length - 1];
    if (capture) capture.parts.push(text);
    else this.out.push(text);
  }

  pushCapture(kind, extra = {}) {
    const capture = { kind, parts: [], hidden: this.hiddenDepth > 0, ...extra };
    this.captures.push(capture);
    return capture;
  }

  /** Telt dit element mee in de structuursamenvatting? Niet als het verborgen is of in een menu of pop-up staat. */
  countable() {
    return this.hiddenDepth === 0 && !this.captures.some((capture) => UNCOUNTED.has(capture.kind));
  }

  inside(names) {
    return this.stack.slice(0, -1).some((frame) => names.has(frame.name));
  }

  findFrame(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].name === name) return this.stack[i];
    }
    return null;
  }

  // --- Parser-events ---

  open(name, attrs) {
    const frame = { name };
    this.stack.push(frame);

    if (name === 'meta') {
      this.readMeta(attrs);
      return;
    }
    this.noteEmbed(name, attrs);

    if (this.skipDepth > 0) {
      if (SKIP_CONTENT.has(name)) {
        frame.skip = true;
        this.skipDepth++;
      }
      return;
    }
    if (this.svgDepth > 0) {
      // Binnen een svg telt alleen de <title>: die beschrijft het icoon of logo.
      if (name === 'svg') {
        frame.svg = true;
        this.svgDepth++;
      } else if (name === 'title') {
        frame.capture = this.pushCapture('svgtitle');
      }
      return;
    }

    if (name === 'title') {
      if (this.titleSeen) {
        frame.skip = true;
        this.skipDepth++;
      } else {
        this.titleSeen = true;
        frame.capture = this.pushCapture('title');
      }
      return;
    }
    if (SKIP_CONTENT.has(name)) {
      // Een paar overgeslagen elementen zijn wél het vermelden waard.
      if (name === 'iframe') this.emit(this.iframeMarker(attrs));
      else if (name === 'video') this.emit(this.videoMarker());
      else if (name === 'textarea') this.emit(this.textareaMarker(attrs));
      frame.skip = true;
      this.skipDepth++;
      return;
    }
    if (name === 'svg') {
      frame.svg = true;
      frame.label = oneLine(attrs['aria-label'] || attrs.title || '');
      this.svgDepth++;
      return;
    }

    // Verborgen blokken vangen we op en vatten we samen; cookiemeldingen en pop-ups krijgen
    // hun eigen label, ook als ze verborgen zijn. Schermlezertekst slaan we helemaal over.
    const hiddenBy = this.keepHidden ? null : hiddenKind(name, attrs);
    if (hiddenBy === 'screenreader') {
      frame.skip = true;
      this.skipDepth++;
      return;
    }
    const hidden = hiddenBy === 'hidden';
    if (hidden) {
      frame.hidden = true;
      this.hiddenDepth++;
    }
    const region = specialRegion(name, attrs);
    if (region && !this.captures.some((capture) => capture.kind === region)) {
      frame.capture = this.pushCapture(region);
      return;
    }
    if (hidden && this.hiddenDepth === 1) frame.hiddenCapture = this.pushCapture('hidden');

    switch (name) {
      case 'br':
        this.emit('\n');
        return;
      case 'hr':
        this.emit('\n\n');
        return;
      case 'img':
        this.emit(this.imageMarker(attrs));
        return;
      case 'input':
        this.emit(this.inputMarker(attrs));
        return;
      case 'select':
        frame.capture = this.pushCapture('select', { attrs, options: [] });
        return;
      case 'option':
        frame.capture = this.pushCapture('option');
        return;
      case 'button':
        frame.capture = this.pushCapture('button', { attrs });
        return;
      case 'nav':
        frame.capture = this.pushCapture('nav');
        return;
      case 'form':
        if (attrs.role === 'search' || SEARCH_FORM.test(`${attrs.id || ''} ${attrs.class || ''} ${attrs.action || ''}`)) {
          frame.capture = this.pushCapture('search');
          return;
        }
        if (this.countable()) this.stats.forms++;
        this.emit('\n[Formulier]\n');
        frame.form = true;
        return;
      case 'main':
        this.emit('\n[Hoofdinhoud]\n');
        frame.block = true;
        return;
      case 'footer':
        if (!this.inside(INNER_REGIONS)) this.emit('\n[Footer]\n');
        frame.block = true;
        return;
      case 'aside':
        if (!this.inside(INNER_REGIONS)) this.emit('\n[Zijbalk]\n');
        frame.block = true;
        return;
      case 'details':
        this.emit('\n[Uitklapbaar]\n');
        frame.block = true;
        return;
      case 'li':
        this.emit('\n- ');
        frame.block = true;
        return;
      case 'td':
      case 'th':
        frame.cell = true;
        return;
      case 'tr':
        frame.row = true;
        return;
      default:
        break;
    }

    if (HEADING.test(name)) {
      frame.capture = this.pushCapture('heading', { level: Number(name[1]) });
      return;
    }
    if (attrs.role === 'navigation' || ((name === 'ul' || name === 'ol' || name === 'div') && this.isMenu(attrs))) {
      frame.capture = this.pushCapture('nav');
      return;
    }
    // Een link die als knop is opgemaakt, tenzij hij in een kop staat: dan is het gewoon de koptekst.
    const inHeading = this.captures.some((capture) => capture.kind === 'heading');
    if (attrs.role === 'button' || (name === 'a' && !inHeading && BUTTON_CLASS.test(attrs.class || ''))) {
      frame.capture = this.pushCapture('button', { attrs });
      return;
    }
    if (INLINE.has(name)) {
      this.emit(SOFT);
      frame.inline = true;
      return;
    }
    if (!SILENT.has(name)) {
      this.emit('\n');
      frame.block = true;
    }
  }

  text(text) {
    if (this.skipDepth > 0) return;
    if (this.svgDepth > 0 && this.captures[this.captures.length - 1]?.kind !== 'svgtitle') return;
    const clean = text.replace(INVISIBLE, '');
    if (clean) this.emit(clean);
  }

  close(name) {
    const frame = this.popFrame(name);
    if (!frame) return;
    if (frame.skip) {
      this.skipDepth--;
      return;
    }
    if (this.skipDepth > 0) return;
    if (frame.capture) this.finishCapture(frame.capture);
    if (frame.svg) {
      this.svgDepth--;
      if (this.svgDepth === 0) this.emit(this.svgMarker(frame));
      return;
    }
    if (this.svgDepth > 0) return;
    if (frame.hiddenCapture) this.finishCapture(frame.hiddenCapture);
    if (frame.hidden) this.hiddenDepth--;
    if (frame.capture || frame.hiddenCapture) return;

    if (frame.inline) this.emit(SOFT);
    else if (frame.cell) this.emit(' | ');
    else if (frame.row) this.emit('\n');
    else if (frame.form) this.emit('\n[Einde formulier]\n');
    else if (frame.block) this.emit(PARAGRAPH.has(name) ? '\n\n' : '\n');
  }

  /** htmlparser2 sluit elementen netjes in volgorde; het zoeken is alleen een vangnet. */
  popFrame(name) {
    const top = this.stack[this.stack.length - 1];
    if (top && top.name === name) return this.stack.pop();
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].name === name) {
        const frame = this.stack[i];
        this.stack.length = i;
        return frame;
      }
    }
    return null;
  }

  finishCapture(capture) {
    if (this.captures[this.captures.length - 1] === capture) this.captures.pop();
    const raw = capture.parts.join('');

    switch (capture.kind) {
      case 'title':
        this.title = oneLine(raw);
        return;
      case 'svgtitle': {
        const svg = this.findFrame('svg');
        if (svg && !svg.label) svg.label = oneLine(raw);
        return;
      }
      case 'option': {
        const parent = this.captures[this.captures.length - 1];
        const label = oneLine(raw);
        if (parent?.kind === 'select' && label) parent.options.push(label);
        return;
      }
      case 'heading': {
        const text = oneLine(raw);
        if (!text) return;
        if (this.countable()) this.stats.headings[capture.level]++;
        this.emit(`\n[H${capture.level}] ${text}\n`);
        return;
      }
      case 'button': {
        const { attrs } = capture;
        const text = oneLine(raw) || oneLine(attrs['aria-label'] || attrs.title || attrs.value || '');
        if (!text) return; // icoonknop zonder tekst, zoals een hamburgermenu
        if (this.countable()) this.stats.buttons++;
        this.emit(` [Knop: ${truncate(text, 80)}] `);
        return;
      }
      case 'select':
        this.emit(this.selectMarker(capture));
        return;
      case 'nav': {
        // Een verborgen menu of een menu in een pop-up (mobiel, off-canvas, mega menu)
        // herhaalt het zichtbare menu: weglaten.
        const inPopup = this.captures.some((other) => other.kind === 'popup' || other.kind === 'cookie');
        if (!capture.hidden && !inPopup) this.emit(this.navMarker(raw));
        return;
      }
      case 'search':
        this.emit('\n[Zoekformulier]\n');
        return;
      case 'hidden':
        this.emit(this.hiddenMarker(raw));
        return;
      case 'cookie':
        this.emit(this.regionMarker('Cookiemelding', raw, 160, capture.hidden, 'cookies'));
        return;
      case 'popup':
        this.emit(this.regionMarker('Pop-up', raw, 200, capture.hidden, 'popups'));
        return;
      default:
        return;
    }
  }

  // --- Markeringen ---

  readMeta(attrs) {
    const key = (attrs.name || attrs.property || '').toLowerCase();
    const content = oneLine(attrs.content || '');
    if (!content) return;
    if (key === 'description' && !this.description) this.description = content;
    else if (key === 'og:description' && !this.ogDescription) this.ogDescription = content;
  }

  /** Formulieren van HubSpot, Typeform en co. staan niet in de HTML; dat melden we één keer. */
  noteEmbed(name, attrs) {
    if (name === 'iframe') return; // krijgt zijn eigen markering
    const haystack = `${name === 'script' ? attrs.src || '' : ''} ${attrs.id || ''} ${attrs.class || ''} ${attrs['data-url'] || ''} ${Object.keys(attrs).filter((key) => key.startsWith('data-')).join(' ')}`;
    for (const [pattern, label] of JS_EMBEDS) {
      if (this.embedsSeen.has(label) || !pattern.test(haystack)) continue;
      this.embedsSeen.add(label);
      this.stats.embeds++;
      this.emit(`\n[Wordt door JavaScript ingeladen: ${label}; de velden staan niet in deze tekst]\n`);
    }
  }

  isMenu(attrs) {
    if (this.captures.some((capture) => capture.kind === 'nav')) return false;
    return MENU_CLASS.test(`${attrs.id || ''} ${attrs.class || ''}`);
  }

  imageMarker(attrs) {
    // Lazy-loading zet een placeholder in src en het echte beeld in een data-attribuut
    // (data-src, data-lazy-src, data-nectar-img-src, data-original …) of in srcset.
    const lazy = Object.keys(attrs).filter((key) => /^data-[a-z-]*(?:src|original|lazy)[a-z-]*$/.test(key) && !key.endsWith('srcset'));
    const candidates = [attrs.src, ...lazy.map((key) => attrs[key]),
      (attrs.srcset || attrs['data-srcset'] || '').split(',')[0]?.trim().split(/\s+/)[0]]
      .filter(Boolean);
    const src = candidates.find((value) => !/^data:/i.test(value)) || candidates[0] || '';

    const width = Number(attrs.width);
    const height = Number(attrs.height);
    if ((width > 0 && width <= 1 && height > 0 && height <= 1) || (src && !/^data:/i.test(src) && TRACKING_SRC.test(src))) return '';
    if (attrs.role === 'presentation' || attrs.role === 'none') return '';

    const counts = this.countable();
    if (counts) this.stats.images++;
    const label = oneLine(attrs.alt || '') || oneLine(attrs['aria-label'] || attrs.title || '');
    if (label) return ` [Afbeelding: ${truncate(label, 120)}] `;

    // WordPress zet alt="" bij elke afbeelding zonder ingevulde alt-tekst; de bestandsnaam
    // verraadt dan vaak alsnog wat het is (klantlogo, keurmerk, teamfoto).
    if (counts) this.stats.imagesNoAlt++;
    if (this.stats.imagesNoAlt > MAX_NOALT_MARKERS) return '';
    const file = imageFileName(src);
    return file ? ` [Afbeelding zonder alt-tekst: ${file}] ` : ' [Afbeelding zonder alt-tekst] ';
  }

  svgMarker(frame) {
    if (!frame.label) return '';
    if (this.countable()) this.stats.images++;
    return ` [Afbeelding: ${truncate(frame.label, 120)}] `;
  }

  videoMarker() {
    if (this.countable()) this.stats.videos++;
    return ' [Video] ';
  }

  iframeMarker(attrs) {
    const src = attrs.src || attrs['data-src'] || '';
    const title = oneLine(attrs.title || '');
    if (/youtube|youtu\.be|vimeo|wistia|vidyard|loom\.com/i.test(src)) {
      if (this.countable()) this.stats.videos++;
      return ` [Video${title ? `: ${title}` : ''}] `;
    }
    if (/google\.[a-z.]+\/maps|maps\.google/i.test(src)) return ' [Kaart: Google Maps] ';
    if (!src || /about:blank|googletagmanager|doubleclick|facebook\.com|recaptcha|gstatic/i.test(src)) return '';
    const embed = JS_EMBEDS.find(([pattern]) => pattern.test(src));
    if (embed) {
      this.stats.embeds++;
      return ` [Ingesloten: ${embed[1]}; de velden staan niet in deze tekst] `;
    }
    let host = '';
    try {
      host = new URL(src, 'https://x.invalid/').hostname;
    } catch {
      host = '';
    }
    if (host === 'x.invalid') host = '';
    return ` [Ingesloten frame${title ? `: ${title}` : host ? `: ${host}` : ''}] `;
  }

  inputMarker(attrs) {
    const type = (attrs.type || 'text').toLowerCase();
    if (type === 'hidden') return '';

    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
      const text = oneLine(attrs.value || attrs['aria-label'] || attrs.alt || attrs.title || (type === 'submit' ? 'Verzenden' : ''));
      if (!text) return '';
      if (this.countable()) this.stats.buttons++;
      return ` [Knop: ${truncate(text, 80)}] `;
    }

    const required = isRequired(attrs);
    if (this.countable()) {
      this.stats.fields++;
      if (required) this.stats.required++;
    }

    // Bij een vinkje of keuzerondje staat het label meestal als tekst erachter.
    const choice = type === 'checkbox' || type === 'radio';
    const label = choice
      ? oneLine(attrs['aria-label'] || attrs.title || '')
      : oneLine(attrs.placeholder || attrs['aria-label'] || attrs.title || attrs.name || attrs.id || '');
    const kind = type === 'checkbox' ? 'Selectievakje' : type === 'radio' ? 'Keuzerondje' : 'Veld';
    const details = [FIELD_TYPES[type], required && 'verplicht'].filter(Boolean).join(', ');
    const name = label || (choice ? '' : 'zonder label');
    return ` [${kind}${name ? `: ${truncate(name, 60)}` : ''}${details ? ` (${details})` : ''}] `;
  }

  textareaMarker(attrs) {
    const required = isRequired(attrs);
    if (this.countable()) {
      this.stats.fields++;
      if (required) this.stats.required++;
    }
    const label = oneLine(attrs.placeholder || attrs['aria-label'] || attrs.title || attrs.name || attrs.id || '');
    return ` [Tekstvak${label ? `: ${truncate(label, 60)}` : ''}${required ? ' (verplicht)' : ''}] `;
  }

  selectMarker({ attrs, options }) {
    const required = isRequired(attrs);
    if (this.countable()) {
      this.stats.fields++;
      if (required) this.stats.required++;
    }
    const label = oneLine(attrs['aria-label'] || attrs.title || attrs.name || attrs.id || '');
    const shown = options.slice(0, MAX_SELECT_OPTIONS);
    const more = options.length - shown.length;
    const choices = shown.length ? ` — ${shown.join(', ')}${more > 0 ? `, … (+${more} meer)` : ''}` : '';
    return ` [Keuzelijst${label ? `: ${truncate(label, 60)}` : ''}${required ? ' (verplicht)' : ''}${choices}] `;
  }

  navMarker(raw) {
    const items = [...new Set(
      normalizeBlock(raw)
        .split('\n')
        .map((line) => line.replace(/^[-•·|\s]+|[|\s]+$/g, ''))
        .filter((line) => line && !SKIP_LINK.test(line)),
    )];
    if (items.length === 0) return '';
    if (this.countable()) this.stats.navs++;
    const shown = items.slice(0, MAX_NAV_ITEMS);
    const more = items.length - shown.length;
    return `\n[Navigatie: ${shown.join(' · ')}${more > 0 ? ` · … (+${more} meer)` : ''}]\n`;
  }

  hiddenMarker(raw) {
    const text = oneLine(normalizeBlock(raw)); // eerst blok-normaliseren: lege opsommingstekens eruit
    if (text.length < MIN_HIDDEN_CHARS) return '';
    this.stats.hidden++;
    this.stats.hiddenChars += text.length;
    if (this.stats.hiddenMarkers >= MAX_HIDDEN_MARKERS) return '';
    this.stats.hiddenMarkers++;
    return `\n[Verborgen blok (${text.length} tekens): ${truncate(text, 100)}]\n`;
  }

  regionMarker(label, raw, max, hidden, statKey) {
    const text = oneLine(normalizeBlock(raw));
    if (!text) return '';
    this.stats[statKey]++;
    return `\n[${label}${hidden ? ', verborgen' : ''}: ${truncate(text, max)}]\n`;
  }

  // --- Resultaat ---

  result() {
    const stats = this.stats;
    const body = dedupeLines(normalizeBlock(this.out.join('')), stats);
    const description = this.description || this.ogDescription;
    const header = [
      this.title && `Paginatitel: ${this.title}`,
      description && `Meta description: ${description}`,
      structureLine(stats),
    ].filter(Boolean).join('\n');

    let text = body ? `${header}\n\n${body}` : header;
    if (text.length > MAX_PAGE_CHARS) {
      const cut = text.lastIndexOf('\n', MAX_PAGE_CHARS);
      text = `${text.slice(0, cut > MAX_PAGE_CHARS - 2000 ? cut : MAX_PAGE_CHARS).trimEnd()}\n\n[... pagina afgekapt op ${MAX_PAGE_CHARS.toLocaleString('nl-NL')} tekens]`;
    }
    return { text, title: this.title, description, bodyLength: body.length, stats };
  }
}

/** Een regel die letterlijk terugkomt (mobiel én desktop menu, herhaalde disclaimer) hoeft maar één keer mee. */
function dedupeLines(text, stats) {
  const seen = new Set();
  const lines = text.split('\n').filter((line) => {
    if (line.length < 60) return true;
    if (seen.has(line)) {
      stats.duplicates++;
      return false;
    }
    seen.add(line);
    return true;
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Korte telling boven de tekst, voor het model én voor wie de log leest. */
function structureLine(stats) {
  const parts = [];
  const headings = stats.headings.map((count, level) => (count ? `${count}× H${level}` : '')).filter(Boolean);
  parts.push(headings.length ? `koppen: ${headings.join(', ')}` : 'geen koppen (H1-H6)');
  parts.push(stats.images
    ? `${plural(stats.images, 'afbeelding', 'afbeeldingen')}${stats.imagesNoAlt ? ` (${stats.imagesNoAlt} zonder alt-tekst)` : ''}`
    : 'geen afbeeldingen');
  if (stats.videos) parts.push(plural(stats.videos, 'video', "video's"));
  if (stats.forms) {
    parts.push(`${plural(stats.forms, 'formulier', 'formulieren')} met ${plural(stats.fields, 'veld', 'velden')}${stats.required ? ` (${stats.required} verplicht)` : ''}`);
  } else if (stats.fields) {
    parts.push(`${plural(stats.fields, 'los formulierveld', 'losse formuliervelden')}${stats.required ? ` (${stats.required} verplicht)` : ''}`);
  } else if (stats.embeds) {
    parts.push('formulier wordt door JavaScript ingeladen');
  } else {
    parts.push('geen formulier');
  }
  if (stats.buttons) parts.push(plural(stats.buttons, 'knop', 'knoppen'));
  if (stats.navs) parts.push(plural(stats.navs, 'navigatiemenu', "navigatiemenu's"));
  if (stats.popups) parts.push(plural(stats.popups, 'pop-up', 'pop-ups'));
  if (stats.cookies) parts.push('cookiemelding');
  if (stats.hidden) parts.push(`${plural(stats.hidden, 'verborgen blok', 'verborgen blokken')} overgeslagen`);
  return `Structuur: ${parts.join(' · ')}`;
}

/**
 * Zet HTML om naar schone tekst met structuurmarkeringen.
 *
 * @param {string} html
 * @param {{keepHidden?: boolean}} [options] keepHidden: verborgen blokken toch als tekst meenemen
 * @returns {{text: string, title: string, description: string, bodyLength: number, stats: object}}
 */
export function htmlToText(html, options = {}) {
  const extractor = new Extractor(options);
  const parser = new Parser({
    onopentag: (name, attrs) => extractor.open(name, attrs),
    ontext: (text) => extractor.text(text),
    onclosetag: (name) => extractor.close(name),
  });
  parser.write(html);
  parser.end();
  return extractor.result();
}

/** Geplakte tekst: onzichtbare tekens eruit, witruimte normaliseren. */
export function cleanPlainText(text) {
  return normalizeBlock(text.replace(INVISIBLE, ''));
}

const BLOCKED_TITLE = /just a moment|attention required|access denied|verify you are human|are you a robot|enable javascript and cookies|pardon our interruption|checking your browser|request blocked|bot verification|security check/i;

/**
 * HTML naar het tekstpakket voor het model, inclusief de herkomstnotitie.
 *
 * Twee vangnetten: verbergt een pagina vrijwel alles met hidden/display:none (tot een
 * script het toont), dan nemen we de verborgen delen alsnog mee; en een botbeveiligings-
 * pagina ("Just a moment…") melden we als zodanig.
 */
export function extractPage(html, source) {
  let page = htmlToText(html);
  if (page.bodyLength < MIN_BODY_CHARS && page.stats.hiddenChars > 500) {
    page = htmlToText(html, { keepHidden: true });
    source += '; de pagina verbergt vrijwel alle tekst met hidden/display:none, verborgen delen zijn meegenomen';
  }
  if (BLOCKED_TITLE.test(page.title)) {
    source = `URL geeft een botbeveiligingspagina ("${truncate(page.title, 40)}"); de echte pagina is niet opgehaald`;
  } else if (page.bodyLength < MIN_BODY_CHARS) {
    source += '; er kwam nauwelijks tekst uit de pagina, mogelijk client-side gerenderd, achter een cookiemuur of simpelweg kort';
  }
  return { text: page.text, source, stats: page.stats };
}

// --- Ophalen ------------------------------------------------------------------------

/**
 * Leest de HTML als tekst met de juiste tekenset. Nederlandse sites draaien soms nog op
 * windows-1252; als UTF-8 lezen levert dan "Ã©Ã©n" op, en dat ziet het model als taalfout.
 */
export function decodeHtml(buffer, contentType = '') {
  const declared = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
    || /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(buffer.subarray(0, 4096).toString('latin1'))?.[1];
  let text = decodeWith(declared || 'utf-8', buffer) ?? decodeWith('utf-8', buffer);
  // Geen opgegeven tekenset en toch vervangingstekens: dan was het waarschijnlijk windows-1252.
  if (!declared && text.includes('�')) text = decodeWith('windows-1252', buffer) ?? text;
  return text;
}

function decodeWith(label, buffer) {
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return null; // onbekende tekenset
  }
}

/** Leest maximaal MAX_HTML_BYTES; de rest van een reuzenpagina laten we liggen. */
async function readBody(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, MAX_HTML_BYTES);
}

/**
 * Haalt de landingspagina op en geeft de tekst terug.
 * Lukt dat niet, dan gooien we geen fout: we geven de URL door met een notitie,
 * zodat het model alsnog kan analyseren wat er wél is.
 *
 * @returns {Promise<{text: string, source: string, stats?: object}>}
 */
export async function resolveLandingpage(input) {
  if (!looksLikeUrl(input)) {
    if (looksLikeHtml(input)) return extractPage(input, 'geplakte HTML-broncode, omgezet naar tekst');
    return { text: cleanPlainText(input), source: 'geplakte content' };
  }

  const url = withScheme(input);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { text: input, source: 'ongeldige URL, ruwe invoer gebruikt' };
  }

  if (!isPublicHost(parsed.hostname)) {
    return { text: input, source: 'URL geweigerd (intern adres), alleen de URL doorgegeven' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LandingpageAdsOptimizer/1.0; intern CRO-analysetool)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.5',
      },
    });

    if (!response.ok) {
      return { text: url, source: `URL gaf status ${response.status}, pagina niet opgehaald` };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      return { text: url, source: `URL leverde ${contentType || 'onbekend type'}, geen tekst opgehaald` };
    }

    const raw = decodeHtml(await readBody(response), contentType);
    if (/text\/plain/i.test(contentType) && !looksLikeHtml(raw)) {
      return { text: cleanPlainText(raw), source: `automatisch opgehaald van ${url} (platte tekst)` };
    }
    return extractPage(raw, `automatisch opgehaald van ${url}`);
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'time-out na 15 seconden' : error.message;
    return { text: url, source: `ophalen mislukt (${reason}), alleen de URL doorgegeven` };
  } finally {
    clearTimeout(timer);
  }
}

// --- Debuggen ------------------------------------------------------------------------

/**
 * Print de schone tekst zoals die naar het model gaat. Lokaal zie je dit in de terminal
 * van `vercel dev`, online onder Deployments → Functions → Logs. Uitzetten kan met de
 * omgevingsvariabele LOG_PAGE_TEXT=false.
 */
export function logPageText(page) {
  if (process.env.LOG_PAGE_TEXT === 'false') return;
  const text = page.text || '';
  const parts = Math.max(1, Math.ceil(text.length / LOG_CHUNK_CHARS));
  console.log(`[Landingspagina] ${page.source} — ${text.length.toLocaleString('nl-NL')} tekens naar het model`);
  for (let i = 0; i < parts; i++) {
    console.log(`--- schone tekst, deel ${i + 1}/${parts} ---\n${text.slice(i * LOG_CHUNK_CHARS, (i + 1) * LOG_CHUNK_CHARS)}`);
  }
  console.log('--- einde schone tekst ---');
}

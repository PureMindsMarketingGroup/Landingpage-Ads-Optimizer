/**
 * Landingpage & Ads Optimizer - het rapport als document
 *
 * Gedeelde bouwstenen voor de drie vormen waarin het rapport verschijnt: het
 * document op het scherm, de PDF (pdf.js) en het Word-bestand (word.js). Zo delen
 * ze één huisstijl (Pure Minds) en lezen ze de Markdown op dezelfde manier: titel,
 * scores, match-iconen en de regels met impact en inspanning.
 */

(() => {
  // --- Huisstijl ---------------------------------------------------------------

  /**
   * Kleuren van pureminds.nl. Cyaan is voor vlakken, lijnen en accenten; kleine tekst
   * staat in inkt of blauw, want tekst in of op cyaan is slecht leesbaar.
   */
  const BRAND = {
    ink: '#303030',
    muted: '#5c6670',
    line: '#e1e7ec',
    zebra: '#f7fafc',
    track: '#eef2f5',
    cyan: '#1ab9e2',
    cyanTint: '#e8f7fc',
    cyanSoft: '#f2fbfe',
    blue: '#1b71a8',
    deep: '#005aaf',
    magenta: '#b61b50',
    placeholderFill: '#fbe8ee',
    placeholderText: '#9e1744',
  };

  /** Beoordelingskleuren uit het logo: groen = goed, oranje = kan beter, magenta = actie nodig. */
  const TONES = {
    good: { solid: '#009670', fill: '#e3f4ee', text: '#00704f' },
    mid: { solid: '#e0951f', fill: '#fdf2de', text: '#8f5600' },
    bad: { solid: '#b61b50', fill: '#fbe8ee', text: '#9e1744' },
    neutral: { solid: '#9aa5ad', fill: '#eef2f5', text: '#5c6670' },
  };

  /** Het logo als WebP voor het scherm en als PNG voor PDF en Word (die kennen geen WebP). */
  const LOGO = { webp: 'pureminds-logo.webp', png: 'pureminds-logo.png', ratio: 640 / 232 };

  // --- De Markdown lezen ---------------------------------------------------------

  /** "CRO Briefing: Offerte zonnepanelen" -> "Offerte zonnepanelen". Leeg als er geen naam in staat. */
  function docName(title) {
    return String(title || '').replace(/^\s*CRO[\s-]*Briefing\s*[:–—-]?\s*/i, '').trim();
  }

  /** Haalt de twee scores uit het rapport. */
  function extractScores(markdown) {
    return [
      ['Algemene score', /Algemene score:?\**\s*(\d+(?:[.,]\d)?)\s*\/\s*10/i],
      ['Message match', /Message Match score:?\**\s*(\d+(?:[.,]\d)?)\s*\/\s*10/i],
    ]
      .map(([label, pattern]) => {
        const match = markdown.match(pattern);
        return match ? { label, value: Math.min(parseFloat(match[1].replace(',', '.')), 10) } : null;
      })
      .filter(Boolean);
  }

  function scoreTone(value) {
    return value >= 7 ? 'good' : value >= 5 ? 'mid' : 'bad';
  }

  function formatScore(value) {
    return String(value).replace('.', ',');
  }

  /** "**Algemene score: 6/10**" op een eigen regel is geen tussenkop. */
  function isScoreLine(text) {
    return /score\s*:?\**\s*\d/i.test(text);
  }

  /** De match-iconen: een label in de Match-kolom, een gekleurd teken in lopende tekst. */
  const MATCHES = [
    { pattern: /✅|✔\u{FE0F}?/u, tone: 'good', label: 'match', mark: '✓' },
    { pattern: /⚠\u{FE0F}?/u, tone: 'mid', label: 'deels', mark: '!' },
    { pattern: /❌|✖\u{FE0F}?/u, tone: 'bad', label: 'geen match', mark: '✕' },
  ];
  const MATCH_ALL = /✅|✔\u{FE0F}?|⚠\u{FE0F}?|❌|✖\u{FE0F}?/gu;
  const MATCH_ANY = /✅|✔\u{FE0F}?|⚠\u{FE0F}?|❌|✖\u{FE0F}?/u;

  /** Knipt tekst op in stukken tekst en match-iconen. */
  function splitMatches(text) {
    const parts = [];
    let last = 0;
    for (const found of String(text).matchAll(MATCH_ALL)) {
      if (found.index > last) parts.push({ text: text.slice(last, found.index) });
      parts.push({ match: MATCHES.find((m) => m.pattern.test(found[0])) });
      last = found.index + found[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
  }

  /**
   * Wat er in de Match-kolom komt. Een kort woord naast het icoon ("⚠️ Deels") wordt
   * het label; een langere toelichting blijft als tekst achter het label staan.
   */
  function matchCell(text) {
    const parts = splitMatches(text);
    const icon = parts.find((part) => part.match);
    if (!icon) return null;
    const rest = parts.filter((part) => part.text).map((part) => part.text).join('').trim();
    const short = rest && rest.length <= 16;
    return { tone: icon.match.tone, label: short ? rest.toLowerCase() : icon.match.label, note: short ? '' : rest };
  }

  const LEVELS = /(Impact|Inspanning)[\s:*_]*(Hoog|Middel|Laag)\b/gi;

  /**
   * Leest "Impact: Hoog · Inspanning: Laag". Groen = gunstig (veel impact, weinig werk),
   * oranje = middel, grijs = minder gunstig. Null als de regel nog iets anders bevat.
   */
  function parseLevels(text) {
    const source = String(text);
    const found = [...source.matchAll(LEVELS)];
    if (found.length === 0) return null;
    if (source.replace(LEVELS, '').replace(/[\s·•|,;:*_/–—-]+/g, '')) return null;

    return found.map(([, rawKey, rawValue]) => {
      const key = capitalize(rawKey);
      const value = capitalize(rawValue);
      const favourable = key === 'Impact' ? 'Hoog' : 'Laag';
      const tone = value === 'Middel' ? 'mid' : value === favourable ? 'good' : 'neutral';
      return { key, value, tone };
    });
  }

  /** "**1. Titel**" op een eigen regel: de nummering los van de titel. */
  function splitNumber(text) {
    const match = String(text).trim().match(/^(\d+)[.)]\s*(.+)$/s);
    return match ? { number: match[1], text: match[2].trim() } : { number: '', text: String(text).trim() };
  }

  /** De gegevens onder de titel: landingspagina en conversiedoel, voor zover bekend. */
  function metaItems(meta) {
    return [
      ['Landingspagina', meta?.landingpage],
      ['Conversiedoel', meta?.conversionGoal],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => ({ label, value }));
  }

  /**
   * Kolombreedtes naar de gemiddelde tekstlengte per kolom, zodat een lange toelichting
   * de ruimte krijgt. De Match-kolom krijgt een vaste, smalle breedte.
   *
   * @param {string[][]} columns per kolom de celteksten, kop eerst
   */
  function columnWidths(columns, total, { matchColumn = -1, matchWidth = 0 } = {}) {
    const weights = columns.map((cells, i) => {
      if (i === matchColumn) return 0;
      const average = cells.reduce((sum, cell) => sum + cell.length, 0) / Math.max(cells.length, 1);
      return Math.sqrt(Math.min(Math.max(average, 8), 90));
    });
    const flexible = total - (matchColumn === -1 ? 0 : matchWidth);
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const widths = weights.map((weight, i) => (i === matchColumn ? matchWidth : Math.floor((flexible * weight) / sum)));
    const lastFlexible = widths.length - 1 === matchColumn ? widths.length - 2 : widths.length - 1;
    if (lastFlexible >= 0) widths[lastFlexible] += total - widths.reduce((a, b) => a + b, 0);
    return widths;
  }

  // --- Bestanden -------------------------------------------------------------------

  function formatDate(date) {
    return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function fileName(name, extension) {
    const slug = name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);
    return `${slug ? `CRO-Briefing-${slug}` : 'CRO-Briefing'}.${extension}`;
  }

  const scripts = new Map();

  /** Laadt een bibliotheek één keer; mislukt het, dan mag de volgende klik het opnieuw proberen. */
  function loadScript(src, errorMessage) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => {
          scripts.delete(src);
          script.remove();
          reject(new Error(errorMessage));
        };
        document.head.appendChild(script);
      }));
    }
    return scripts.get(src);
  }

  const files = new Map();

  /** Haalt een bestand uit de tool zelf op (lettertype, logo), één keer per sessie. */
  function fetchBytes(path) {
    if (!files.has(path)) {
      files.set(path, fetch(path)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then((buffer) => new Uint8Array(buffer))
        .catch(() => {
          files.delete(path);
          throw new Error(`${path} kon niet geladen worden. Controleer je internetverbinding.`);
        }));
    }
    return files.get(path);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  const entityDecoder = document.createElement('textarea');

  /** marked laat HTML-entities (&amp;, &quot;) soms in de tokentekst staan. */
  function decode(text) {
    if (!text || !text.includes('&')) return text || '';
    entityDecoder.innerHTML = text;
    return entityDecoder.value;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  // --- Markdown veilig renderen ------------------------------------------------------

  // Het model schrijft Markdown. Ruwe HTML (bijvoorbeeld overgenomen uit een opgehaalde
  // pagina) tonen we als tekst, zodat die nooit als code in de tool terechtkomt.
  marked.use({
    renderer: {
      html: ({ text }) => (/^<br\s*\/?>$/i.test(text.trim()) ? '<br>' : escapeHtml(text)),
      link(token) {
        return /^(https?:|mailto:)/i.test(token.href) ? false : this.parser.parseInline(token.tokens);
      },
      image: ({ text }) => escapeHtml(text),
    },
  });

  // --- Het document op het scherm ------------------------------------------------------

  /** Eén logo-element dat bij elke nieuwe render wordt verplaatst, zodat het tijdens het streamen niet knippert. */
  let logoElement = null;

  /** Wat er in de laatste render stond; nodig voor de kopieerversie. */
  const rendered = new WeakMap();

  /**
   * Zet de Markdown als opgemaakt document in `container`: een kop met logo, titel,
   * gegevens en scores, daarna de secties.
   */
  function renderDocument(container, markdown, meta) {
    const body = el('div', 'doc-body');
    body.innerHTML = marked.parse(markdown);

    const h1 = body.querySelector('h1');
    const name = docName(h1?.textContent);
    h1?.remove();
    decorateBody(body);

    const scores = extractScores(markdown);
    container.replaceChildren(docHead(name, meta, scores), body);
    rendered.set(container, { name, meta, scores });
  }

  function docHead(name, meta, scores) {
    const head = el('header', 'doc-head');

    if (!logoElement) {
      logoElement = el('img', 'doc-logo');
      logoElement.src = LOGO.webp;
      logoElement.alt = 'Pure Minds';
    }
    const kicker = el('p', 'doc-kicker');
    kicker.append(el('strong', '', 'CRO BRIEFING'), formatDate(meta?.generatedAt ? new Date(meta.generatedAt) : new Date()));
    const top = el('div', 'doc-top');
    top.append(logoElement, kicker);

    const title = el('h1', 'doc-title', name || 'CRO Briefing');
    if (/[\p{L}\p{N}]$/u.test(title.textContent)) title.append(el('span', 'doc-dot', '.'));
    head.append(top, title);

    const items = metaItems(meta);
    if (items.length > 0) {
      const list = el('dl', 'doc-meta');
      items.forEach(({ label, value }) => {
        const row = el('div');
        row.append(el('dt', '', label), el('dd', '', value));
        list.append(row);
      });
      head.append(list);
    }

    if (scores.length > 0) {
      const grid = el('div', 'doc-scores');
      scores.forEach((score) => grid.append(scoreTile(score)));
      head.append(grid);
    }
    return head;
  }

  function scoreTile({ label, value }) {
    const tone = TONES[scoreTone(value)];
    const tile = el('div', 'score-tile');
    tile.style.borderLeftColor = tone.solid;

    const number = el('p', 'score-value', formatScore(value));
    number.append(el('small', '', ' / 10'));
    const bar = el('div', 'score-bar');
    const fill = el('span');
    fill.style.cssText = `width:${value * 10}%;background:${tone.solid}`;
    bar.append(fill);

    tile.append(el('p', 'score-label', label), number, bar);
    return tile;
  }

  function decorateBody(body) {
    body.querySelectorAll('h1, h2').forEach((heading) => {
      const { number, text } = splitNumber(heading.textContent);
      const h2 = el('h2');
      if (number) h2.append(el('span', 'doc-num', number));
      h2.append(el('span', '', text));
      heading.replaceWith(h2);
    });

    // "**1. Titel van het verbeterpunt**" op een eigen regel is een tussenkop.
    body.querySelectorAll('p').forEach((p) => {
      const strong = p.firstElementChild;
      const isSubheading = p.childElementCount === 1 && strong.tagName === 'STRONG' &&
        p.textContent.trim() === strong.textContent.trim() &&
        !isScoreLine(p.textContent) && !p.closest('li, td, th, blockquote');
      if (isSubheading) {
        const h3 = el('h3');
        h3.textContent = p.textContent;
        p.replaceWith(h3);
      }
    });
    body.querySelectorAll('h3, h4').forEach((heading) => {
      const { number, text } = splitNumber(heading.textContent);
      const h3 = el('h3');
      if (number) h3.append(el('span', 'doc-sub-num', `${number}.`), ' ');
      h3.append(text);
      heading.replaceWith(h3);
    });

    body.querySelectorAll('li').forEach((li) => {
      if (li.querySelector('ul, ol')) return;
      const levels = parseLevels(li.textContent);
      if (!levels) return;
      li.className = 'doc-levels';
      // De spatie telt niet in de flex-weergave, maar houdt de labels uit elkaar bij kopiëren.
      li.replaceChildren(...levels.flatMap(({ key, value, tone }, i) => [...(i > 0 ? [' '] : []), pill(value.toLowerCase(), tone, key)]));
    });

    body.querySelectorAll('table').forEach((table) => {
      const wrap = el('div', 'table-wrap');
      table.replaceWith(wrap);
      wrap.append(table);

      const headers = [...table.querySelectorAll('thead th')];
      const matchColumn = headers.findIndex((th) => /^match$/i.test(th.textContent.trim()));
      if (matchColumn === -1) return;
      headers[matchColumn].classList.add('col-match');
      table.querySelectorAll('tbody tr').forEach((row) => {
        const cell = row.children[matchColumn];
        const match = cell && matchCell(cell.textContent);
        if (!match) return;
        cell.replaceChildren(pill(match.label, match.tone));
        if (match.note) cell.append(' ', match.note);
      });
    });

    // Overige match-iconen in lopende tekst worden gekleurde tekens.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const withIcons = [];
    while (walker.nextNode()) {
      if (MATCH_ANY.test(walker.currentNode.nodeValue)) withIcons.push(walker.currentNode);
    }
    withIcons.forEach((node) => {
      const fragment = document.createDocumentFragment();
      splitMatches(node.nodeValue).forEach((part) => {
        if (part.text) fragment.append(part.text);
        else {
          const mark = el('span', 'doc-mark', part.match.mark);
          mark.style.color = TONES[part.match.tone].solid;
          fragment.append(mark);
        }
      });
      node.replaceWith(fragment);
    });
  }

  /** Een label in een toonkleur. Inline gestyled, zodat de kleur ook meegaat bij kopiëren. */
  function pill(text, tone, key) {
    const colors = TONES[tone];
    const span = el('span', 'pill');
    span.style.cssText = `background:${colors.fill};color:${colors.text}`;
    if (key) span.append(el('span', 'pill-key', `${key} `));
    span.append(el('strong', '', text));
    return span;
  }

  // --- Kopiëren naar Google Docs, Word of e-mail ----------------------------------------

  /** Google Docs en Word lezen geen stylesheet, alleen inline stijlen. */
  const COPY_STYLES = [
    ['h2', `margin:22pt 0 8pt;padding-bottom:4pt;border-bottom:2px solid ${BRAND.cyan};font-size:16pt;line-height:1.3;font-weight:700;color:${BRAND.ink}`],
    ['h3', `margin:14pt 0 4pt;font-size:12pt;line-height:1.35;font-weight:700;color:${BRAND.ink}`],
    ['p', `margin:0 0 8pt;font-size:10.5pt;line-height:1.5;color:${BRAND.ink}`],
    ['ul, ol', 'margin:0 0 8pt;padding-left:20pt'],
    ['li', `margin:0 0 4pt;font-size:10.5pt;line-height:1.5;color:${BRAND.ink}`],
    ['table', 'width:100%;border-collapse:collapse;margin:4pt 0 12pt'],
    ['th', `padding:5pt 6pt;background:${BRAND.cyanTint};border-bottom:2px solid ${BRAND.cyan};text-align:left;vertical-align:top;font-size:9.5pt;font-weight:700;color:${BRAND.ink}`],
    ['td', `padding:5pt 6pt;border-bottom:1px solid ${BRAND.line};vertical-align:top;font-size:9.5pt;color:${BRAND.ink}`],
    ['blockquote', `margin:6pt 0 10pt;padding:6pt 10pt;border-left:4px solid ${BRAND.cyan};background:${BRAND.cyanSoft}`],
    ['code', `font-family:inherit;font-weight:700;background:${BRAND.placeholderFill};color:${BRAND.placeholderText}`],
    ['a', `color:${BRAND.blue}`],
    ['.doc-num, .doc-sub-num', `color:${BRAND.cyan}`],
    ['.pill', 'font-size:9pt;white-space:nowrap'],
    ['li.doc-levels', 'list-style:none'],
  ];

  /** De huidige render als HTML met inline opmaak, voor op het klembord. */
  function clipboardHtml(container) {
    const { name, meta, scores } = rendered.get(container) || {};
    const body = container.querySelector('.doc-body').cloneNode(true);

    body.querySelectorAll('.doc-num').forEach((num) => { num.textContent = `${num.textContent}. `; });
    body.querySelectorAll('.table-wrap').forEach((wrap) => wrap.replaceWith(...wrap.childNodes));
    for (const [selector, style] of COPY_STYLES) {
      body.querySelectorAll(selector).forEach((node) => { node.style.cssText = `${style};${node.style.cssText}`; });
    }

    const date = formatDate(meta?.generatedAt ? new Date(meta.generatedAt) : new Date());
    const dot = /[\p{L}\p{N}]$/u.test(name || 'CRO Briefing') ? `<span style="color:${BRAND.cyan}">.</span>` : '';
    const metaLines = metaItems(meta)
      .map(({ label, value }) => `<strong>${label}:</strong> ${escapeHtml(value)}`)
      .join('<br>');
    const scoreCells = (scores || [])
      .map(({ label, value }) => `<td style="padding:6pt 16pt 6pt 10pt;border-left:4px solid ${TONES[scoreTone(value)].solid};background:${BRAND.zebra}">` +
        `<span style="font-size:8pt;font-weight:700;color:${BRAND.muted}">${label.toUpperCase()}</span><br>` +
        `<span style="font-size:18pt;font-weight:700;color:${BRAND.ink}">${formatScore(value)}</span>` +
        `<span style="font-size:10pt;color:${BRAND.muted}"> / 10</span></td>`)
      .join('<td style="width:10pt"></td>');

    return '<meta charset="utf-8">' +
      `<div style="font-family:'Open Sans',Arial,sans-serif;font-size:10.5pt;line-height:1.5;color:${BRAND.ink}">` +
      `<p style="margin:0 0 2pt;font-size:9pt;font-weight:700;letter-spacing:1.5pt;color:${BRAND.blue}">CRO BRIEFING · ${date.toUpperCase()}</p>` +
      `<h1 style="margin:0 0 8pt;font-size:24pt;line-height:1.2;font-weight:700;color:${BRAND.ink}">${escapeHtml(name || 'CRO Briefing')}${dot}</h1>` +
      (metaLines ? `<p style="margin:0 0 8pt;font-size:10pt;line-height:1.5;color:${BRAND.ink}">${metaLines}</p>` : '') +
      (scoreCells ? `<table style="border-collapse:collapse;margin:6pt 0 10pt"><tr>${scoreCells}</tr></table>` : '') +
      body.innerHTML +
      '</div>';
  }

  function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  window.Report = {
    BRAND,
    TONES,
    LOGO,
    docName,
    extractScores,
    scoreTone,
    formatScore,
    isScoreLine,
    splitMatches,
    matchCell,
    parseLevels,
    splitNumber,
    metaItems,
    columnWidths,
    formatDate,
    fileName,
    loadScript,
    fetchBytes,
    saveBlob,
    decode,
    renderDocument,
    clipboardHtml,
  };
})();

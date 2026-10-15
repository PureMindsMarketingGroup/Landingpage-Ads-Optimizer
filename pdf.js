/**
 * Landingpage & Ads Optimizer - PDF-export
 *
 * Zet het Markdown-rapport met pdfmake om naar een echte tekst-PDF in de huisstijl
 * van Pure Minds: scherp, selecteerbaar, met logo en paginanummers, en zonder regels
 * die over een paginarand worden afgeknipt (wat een screenshot-PDF wel doet).
 *
 * pdfmake is ruim 1 MB en wordt daarom pas bij de eerste klik geladen. Het lettertype
 * is Open Sans, net als op pureminds.nl; de bestanden staan in fonts/.
 */

(() => {
  const PDFMAKE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.12/pdfmake.min.js';
  const { BRAND, TONES } = Report;

  /** Bestand in de tool -> naam in het virtuele bestandssysteem van pdfmake. */
  const FONT_FILES = {
    normal: 'fonts/OpenSans-Regular.ttf',
    bold: 'fonts/OpenSans-Bold.ttf',
    italics: 'fonts/OpenSans-Italic.ttf',
    bolditalics: 'fonts/OpenSans-BoldItalic.ttf',
  };
  const vfsName = (path) => path.split('/').pop();

  /** Onzichtbaar breekpunt, zodat een lange URL netjes over twee regels kan. */
  const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

  // A4 in punten.
  const PAGE_WIDTH = 595.28;
  const MARGIN_X = 56;
  const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;

  /** Tekens die niet in Open Sans staan, vervangen door een teken dat er wel in staat. */
  const GLYPHS = [
    [/[→⇒➔➜]/gu, '›'],
    [/[←⇐]/gu, '‹'],
    [/↑/gu, '+'],
    [/↓/gu, '−'],
    [/[✓✔]/gu, '√'],
    [/[✗✘✕✖]/gu, '×'],
    [/[●■▪▸►◆]/gu, '•'],
    [/[★☆]/gu, '*'],
    [/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ''],
  ];

  /**
   * Bouwt en downloadt de PDF.
   *
   * @param {{markdown: string, meta?: {generatedAt?: number, landingpage?: string, conversionGoal?: string}}} report
   */
  window.downloadReportPdf = async function downloadReportPdf({ markdown, meta }) {
    const paths = [...Object.values(FONT_FILES), Report.LOGO.png];
    const [, ...files] = await Promise.all([
      Report.loadScript(PDFMAKE_SRC, 'De PDF-module kon niet geladen worden. Controleer je internetverbinding.'),
      ...paths.map((path) => Report.fetchBytes(path)),
    ]);
    const vfs = Object.fromEntries(paths.map((path, i) => [vfsName(path), files[i]]));
    const fonts = { OpenSans: Object.fromEntries(Object.entries(FONT_FILES).map(([type, path]) => [type, vfsName(path)])) };

    const tokens = marked.lexer(markdown);
    const titleIndex = tokens.findIndex((t) => t.type === 'heading' && t.depth === 1);
    const name = titleIndex === -1 ? '' : Report.docName(plainText(tokens[titleIndex].tokens));
    const title = name || 'CRO Briefing';
    const bodyTokens = tokens.filter((_, i) => i !== titleIndex);
    const date = Report.formatDate(meta?.generatedAt ? new Date(meta.generatedAt) : new Date());

    const docDefinition = {
      pageSize: 'A4',
      pageMargins: [MARGIN_X, 70, MARGIN_X, 64],
      info: { title: `CRO Briefing: ${title}`, subject: 'CRO Briefing', author: 'Pure Minds', creator: 'Landingpage & Ads Optimizer' },
      images: { logo: vfsName(Report.LOGO.png) },

      // Cyaan-blauwe balk bovenaan elke pagina, zoals de balk op pureminds.nl.
      background: () => ({ canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE_WIDTH, h: 6, linearGradient: [BRAND.cyan, BRAND.deep] }] }),
      header: (page) => (page === 1 ? { text: '' } : {
        columns: [
          { image: 'logo', width: 64 },
          { text: pdfText(title), style: 'running', alignment: 'right', margin: [0, 8, 0, 0] },
        ],
        margin: [MARGIN_X, 24, MARGIN_X, 0],
      }),
      footer: (page, count) => ({
        stack: [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: BRAND.line }] },
          {
            columns: [
              { text: [{ text: 'pure minds', bold: true }, '  ·  Landingpage & Ads Optimizer'], style: 'running' },
              { text: `${page} / ${count}`, style: 'running', alignment: 'right' },
            ],
            margin: [0, 8, 0, 0],
          },
        ],
        margin: [MARGIN_X, 20, MARGIN_X, 0],
      }),

      // Een kop mag niet als laatste regel onderaan een pagina blijven hangen.
      pageBreakBefore: (node, followingNodesOnPage) =>
        Boolean(node.headlineLevel) &&
        (followingNodesOnPage.length === 0 || node.startPosition.verticalRatio > (node.headlineLevel === 1 ? 0.8 : 0.88)),

      content: [
        ...cover(title, date, meta, Report.extractScores(markdown)),
        ...blocks(bodyTokens),
      ],

      defaultStyle: { font: 'OpenSans', fontSize: 9.5, lineHeight: 1.35, color: BRAND.ink },
      styles: {
        eyebrow: { fontSize: 7.5, bold: true, color: BRAND.blue, characterSpacing: 1.6 },
        date: { fontSize: 8.5, color: BRAND.muted, margin: [0, 2, 0, 0] },
        title: { fontSize: 25, bold: true, lineHeight: 1.12, margin: [0, 34, 0, 0] },
        label: { fontSize: 7, bold: true, color: BRAND.muted, characterSpacing: 0.8 },
        metaValue: { fontSize: 9.5, bold: true, lineHeight: 1.25, margin: [0, 2, 0, 0] },
        h2: { fontSize: 15, bold: true, margin: [0, 24, 0, 0] },
        h3: { fontSize: 11, bold: true, lineHeight: 1.25, margin: [0, 12, 0, 4] },
        p: { margin: [0, 0, 0, 7] },
        li: { margin: [0, 0, 0, 3] },
        list: { margin: [0, 0, 0, 8] },
        th: { fontSize: 8.5, bold: true },
        td: { fontSize: 8.5, lineHeight: 1.3 },
        running: { fontSize: 7.5, color: BRAND.muted },
      },
    };

    const blob = await createBlob(docDefinition, fonts, vfs);
    Report.saveBlob(blob, Report.fileName(name, 'pdf'));
  };

  /**
   * pdfmake 0.2 geeft fouten binnen zijn eigen promise niet door aan de aanroeper.
   * Zonder deze vangst blijft de knop bij een fout eeuwig op "pdf maken…" staan.
   */
  function createBlob(docDefinition, fonts, vfs) {
    return new Promise((resolve, reject) => {
      const onError = (event) => {
        cleanup();
        reject(event.reason instanceof Error ? event.reason : new Error('De PDF kon niet gemaakt worden.'));
      };
      const cleanup = () => window.removeEventListener('unhandledrejection', onError);
      window.addEventListener('unhandledrejection', onError);
      try {
        pdfMake.createPdf(docDefinition, null, fonts, vfs).getBlob((blob) => {
          cleanup();
          resolve(blob);
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  // --- Voorblad ------------------------------------------------------------------

  function cover(title, date, meta, scores) {
    const dot = /[\p{L}\p{N}]$/u.test(title) ? [{ text: '.', color: BRAND.cyan }] : [];
    return [
      {
        columns: [
          { image: 'logo', width: 124 },
          {
            stack: [{ text: 'CRO BRIEFING', style: 'eyebrow' }, { text: date, style: 'date' }],
            alignment: 'right',
            margin: [0, 12, 0, 0],
          },
        ],
      },
      { text: [pdfText(title), ...dot], style: 'title' },
      metaColumns(meta),
      scoreTiles(scores),
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.75, lineColor: BRAND.line }], margin: [0, 22, 0, 0] },
    ];
  }

  function metaColumns(meta) {
    const items = Report.metaItems(meta);
    if (items.length === 0) return { text: '' };
    return {
      columns: items.map(({ label, value }) => ({
        stack: [
          { text: label.toUpperCase(), style: 'label' },
          // Lange URL's mogen na een / of ? afbreken.
          { text: pdfText(value).replace(/[/?&=]/g, (char) => char + ZERO_WIDTH_SPACE), style: 'metaValue' },
        ],
      })),
      columnGap: 24,
      margin: [0, 14, 0, 0],
    };
  }

  function scoreTiles(scores) {
    if (scores.length === 0) return { text: '' };
    const gap = 12;
    const tileWidth = (CONTENT_WIDTH - gap * (scores.length - 1)) / scores.length;
    const barWidth = tileWidth - 32;

    return {
      columns: scores.map(({ label, value }) => {
        const tone = TONES[Report.scoreTone(value)];
        return {
          width: tileWidth,
          table: {
            widths: ['*'],
            body: [[{
              stack: [
                { text: label.toUpperCase(), style: 'label' },
                {
                  text: [
                    { text: Report.formatScore(value), fontSize: 22, bold: true },
                    { text: ' / 10', fontSize: 10, color: BRAND.muted },
                  ],
                  margin: [0, 1, 0, 5],
                },
                {
                  canvas: [
                    { type: 'rect', x: 0, y: 0, w: barWidth, h: 4, color: BRAND.track },
                    { type: 'rect', x: 0, y: 0, w: (barWidth * value) / 10, h: 4, color: tone.solid },
                  ],
                },
              ],
            }]],
          },
          layout: {
            hLineWidth: () => 0.75,
            vLineWidth: (i) => (i === 0 ? 3.5 : 0.75),
            hLineColor: () => BRAND.line,
            vLineColor: (i) => (i === 0 ? tone.solid : BRAND.line),
            paddingLeft: () => 13,
            paddingRight: () => 12,
            paddingTop: () => 10,
            paddingBottom: () => 11,
          },
        };
      }),
      columnGap: gap,
      margin: [0, 20, 0, 0],
    };
  }

  // --- Markdown-tokens naar pdfmake --------------------------------------------

  function blocks(tokens, { inList = false, depth = 0 } = {}) {
    const out = [];
    for (const token of tokens || []) {
      switch (token.type) {
        case 'heading':
          out.push(...heading(token));
          break;
        case 'paragraph':
          out.push(paragraph(token, inList));
          break;
        case 'text':
          out.push({ text: token.tokens ? inline(token.tokens) : symbols(Report.decode(token.text)), style: inList ? 'li' : 'p' });
          break;
        case 'list':
          out.push(list(token, depth));
          break;
        case 'table':
          out.push(table(token));
          break;
        case 'blockquote':
          out.push(box(blocks(token.tokens), BRAND.cyanSoft, BRAND.cyan));
          break;
        case 'code':
          out.push(box([{ text: pdfText(token.text), fontSize: 8.5 }], BRAND.zebra, BRAND.line));
          break;
        case 'hr':
          out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: BRAND.line }], margin: [0, 8, 0, 12] });
          break;
        default:
          break; // space, html: niets te tonen
      }
    }
    return out;
  }

  /** Sectiekop: nummer in cyaan, met het kleurverloop van de site eronder. */
  function heading(token) {
    const { number, text } = Report.splitNumber(plainText(token.tokens));
    if (token.depth <= 2) {
      return [
        { text: [...(number ? [{ text: `${number}  `, color: BRAND.cyan }] : []), text], style: 'h2', headlineLevel: 1 },
        { canvas: [{ type: 'rect', x: 0, y: 0, w: 42, h: 3, linearGradient: [BRAND.cyan, BRAND.deep] }], margin: [0, 6, 0, 10] },
      ];
    }
    return [subheading(number, text)];
  }

  function subheading(number, text) {
    return { text: [...(number ? [{ text: `${number}. `, color: BRAND.blue }] : []), text], style: 'h3', headlineLevel: 2 };
  }

  /** "**1. Titel van het verbeterpunt**" op een eigen regel gedraagt zich als tussenkop. */
  function paragraph(token, inList) {
    const meaningful = (token.tokens || []).filter((t) => !(t.type === 'text' && !t.text.trim()));
    if (!inList && meaningful.length === 1 && meaningful[0].type === 'strong' && !Report.isScoreLine(token.text)) {
      const { number, text } = Report.splitNumber(plainText(meaningful[0].tokens));
      return subheading(number, text);
    }
    return { text: inline(token.tokens), style: inList ? 'li' : 'p' };
  }

  function list(token, depth) {
    const items = token.items.map((item) => {
      const levels = Report.parseLevels(item.text);
      if (levels) return { text: levelRuns(levels), style: 'li', listType: 'none', margin: [0, 2, 0, 5] };
      const content = blocks(item.tokens, { inList: true, depth: depth + 1 });
      return content.length === 1 ? content[0] : { stack: content };
    });
    return token.ordered
      ? { style: 'list', ol: items, start: Number(token.start) || 1, markerColor: BRAND.blue }
      : { style: 'list', ul: items, type: 'square', markerColor: depth > 0 ? '#b5c2cb' : BRAND.cyan };
  }

  /** "Impact: Hoog · Inspanning: Laag" als twee gekleurde labels. */
  function levelRuns(levels) {
    const runs = [];
    levels.forEach(({ key, value, tone }, i) => {
      const colors = TONES[tone];
      if (i > 0) runs.push({ text: '   ' });
      runs.push(
        { text: ` ${key} `, fontSize: 8.5, color: colors.text, background: colors.fill },
        { text: `${value.toLowerCase()} `, fontSize: 8.5, bold: true, color: colors.text, background: colors.fill },
      );
    });
    return runs;
  }

  function table(token) {
    const columns = token.header.length;
    const matchColumn = token.header.findIndex((cell) => /^match$/i.test(cell.text.trim()));
    const padding = 6;
    const texts = token.header.map((head, i) => [head.text, ...token.rows.map((row) => row[i]?.text || '')]);
    const widths = Report.columnWidths(texts, CONTENT_WIDTH - columns * 2 * padding, { matchColumn, matchWidth: 60 });

    const body = [
      token.header.map((cell) => ({ text: inline(cell.tokens), style: 'th' })),
      // Een rij met te veel of te weinig cellen laat pdfmake crashen: gelijk trekken.
      ...token.rows.map((row) => Array.from({ length: columns }, (_, i) => tableCell(row[i], i === matchColumn))),
    ];

    return {
      table: { headerRows: 1, dontBreakRows: true, widths, body },
      layout: {
        fillColor: (row) => (row === 0 ? BRAND.cyanTint : row % 2 === 0 ? BRAND.zebra : null),
        hLineWidth: (i) => (i === 0 ? 0 : i === 1 ? 1.25 : 0.5),
        hLineColor: (i) => (i === 1 ? BRAND.cyan : BRAND.line),
        vLineWidth: () => 0,
        paddingLeft: () => padding,
        paddingRight: () => padding,
        paddingTop: () => 5,
        paddingBottom: () => 5,
      },
      margin: [0, 4, 0, 12],
    };
  }

  function tableCell(cell, isMatchColumn) {
    if (!cell) return { text: '', style: 'td' };
    const match = isMatchColumn && Report.matchCell(cell.text);
    if (match) {
      const colors = TONES[match.tone];
      return {
        text: [
          { text: ` ${match.label} `, bold: true, color: colors.text, background: colors.fill },
          ...(match.note ? [` ${pdfText(match.note)}`] : []),
        ],
        style: 'td',
      };
    }
    return { text: inline(cell.tokens), style: 'td' };
  }

  function box(stack, fill, bar) {
    return {
      table: { widths: ['*'], body: [[{ stack }]] },
      layout: {
        fillColor: () => fill,
        hLineWidth: () => 0,
        vLineWidth: (i) => (i === 0 ? 3 : 0),
        vLineColor: () => bar,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 7,
        paddingBottom: () => 1,
      },
      margin: [0, 4, 0, 10],
    };
  }

  // --- Inline opmaak -----------------------------------------------------------

  function inline(tokens, style = {}) {
    const out = [];
    for (const token of tokens || []) {
      switch (token.type) {
        case 'strong':
          out.push(...inline(token.tokens, { ...style, bold: true }));
          break;
        case 'em':
          out.push(...inline(token.tokens, { ...style, italics: true }));
          break;
        case 'del':
          out.push(...inline(token.tokens, { ...style, decoration: 'lineThrough' }));
          break;
        case 'codespan':
          // Placeholders als [aantal klanten invullen] vallen zo op in de PDF.
          out.push({ ...style, text: ` ${pdfText(Report.decode(token.text))} `, bold: true, color: BRAND.placeholderText, background: BRAND.placeholderFill });
          break;
        case 'link':
          out.push(...inline(token.tokens, /^(https?:|mailto:)/i.test(token.href)
            ? { ...style, color: BRAND.blue, decoration: 'underline', link: token.href }
            : style));
          break;
        case 'br':
          out.push({ text: '\n' });
          break;
        case 'html':
          if (/^<br\s*\/?>$/i.test(token.text.trim())) out.push({ text: '\n' });
          else out.push(...symbols(Report.decode(token.text), style));
          break;
        case 'text':
          out.push(...(token.tokens ? inline(token.tokens, style) : symbols(Report.decode(token.text), style)));
          break;
        default:
          if (token.text) out.push(...symbols(Report.decode(token.text), style));
      }
    }
    return out;
  }

  /** Match-iconen worden gekleurde tekens; wat niet in het lettertype staat, wordt vervangen. */
  function symbols(text, style = {}) {
    return Report.splitMatches(text)
      .map((part) => (part.match
        ? { ...style, text: pdfText(part.match.mark), bold: true, color: TONES[part.match.tone].solid }
        : { ...style, text: pdfText(part.text) }))
      .filter((part) => part.text !== '');
  }

  function pdfText(text) {
    return GLYPHS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), String(text));
  }

  function plainText(tokens) {
    return inline(tokens).map((part) => part.text).join('').trim();
  }
})();

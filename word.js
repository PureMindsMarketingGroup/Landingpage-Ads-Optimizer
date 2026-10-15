/**
 * Landingpage & Ads Optimizer - Word-export
 *
 * Bouwt met de docx-bibliotheek een echt .docx-bestand in de huisstijl van Pure Minds:
 * voorblad met scores, genummerde secties, tabellen, en kop- en voettekst met logo en
 * paginanummers. Het blijft een gewoon bewerkbaar Word-document, en Google Drive zet
 * het bij openen om naar een Google Doc.
 *
 * docx is ruim 400 kB en wordt daarom pas bij de eerste klik geladen.
 */

(() => {
  const DOCX_SRC = 'https://cdn.jsdelivr.net/npm/docx@9.7.1/dist/index.iife.min.js';
  const { BRAND, TONES } = Report;
  const FONT = 'Open Sans';

  // A4 met marges van 2 cm. Maten in twips (1/20 punt), lettergroottes in halve punten.
  const PAGE = { width: 11906, height: 16838, marginX: 1134, marginTop: 1418, marginBottom: 1247, header: 567, footer: 567 };
  const TEXT_WIDTH = PAGE.width - 2 * PAGE.marginX;

  const color = (value) => value.replace('#', '').toUpperCase();

  /** Word kan deze tekens niet laten zien in Open Sans, maar valt terug op een systeemletter. */
  const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

  let D; // de docx-bibliotheek, na het laden

  /**
   * Bouwt en downloadt het Word-bestand.
   *
   * @param {{markdown: string, meta?: {generatedAt?: number, landingpage?: string, conversionGoal?: string}}} report
   */
  window.downloadReportDocx = async function downloadReportDocx({ markdown, meta }) {
    const [, logo] = await Promise.all([
      Report.loadScript(DOCX_SRC, 'De Word-module kon niet geladen worden. Controleer je internetverbinding.'),
      Report.fetchBytes(Report.LOGO.png),
    ]);
    D = window.docx;

    const tokens = marked.lexer(markdown);
    const titleIndex = tokens.findIndex((t) => t.type === 'heading' && t.depth === 1);
    const name = titleIndex === -1 ? '' : Report.docName(plainText(tokens[titleIndex].tokens));
    const title = name || 'CRO Briefing';
    const date = Report.formatDate(meta?.generatedAt ? new Date(meta.generatedAt) : new Date());

    // Genummerde lijsten beginnen elk opnieuw; welke startnummers er zijn, weten we pas na het doorlopen.
    const context = { orderedStarts: new Set(), listInstance: 0 };
    const children = [
      ...cover(title, date, meta, Report.extractScores(markdown)),
      ...blocks(tokens.filter((_, i) => i !== titleIndex), context),
    ];

    const doc = new D.Document({
      creator: 'Pure Minds',
      title: `CRO Briefing: ${title}`,
      description: 'CRO Briefing, gemaakt met de Landingpage & Ads Optimizer',
      styles: styles(),
      numbering: { config: numbering(context.orderedStarts) },
      sections: [{
        properties: {
          titlePage: true,
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: { top: PAGE.marginTop, bottom: PAGE.marginBottom, left: PAGE.marginX, right: PAGE.marginX, header: PAGE.header, footer: PAGE.footer },
          },
        },
        headers: {
          first: new D.Header({ children: [headerLine(logo, 140, [])] }),
          default: new D.Header({ children: [headerLine(logo, 88, [new D.TextRun({ text: title, size: 15, color: color(BRAND.muted) })])] }),
        },
        footers: { first: footer(), default: footer() },
        children,
      }],
    });

    const blob = await D.Packer.toBlob(doc, false, [{ path: 'word/fontTable.xml', data: FONT_TABLE }]);
    Report.saveBlob(blob, Report.fileName(name, 'docx'));
  };

  // --- Opmaak ---------------------------------------------------------------------

  function styles() {
    return {
      // lineRule expliciet op "auto" (een veelvoud van de regelhoogte): sommige viewers lezen een
      // ontbrekende lineRule als vaste hoogte in punten, en dan overlappen grote koppen.
      default: {
        document: {
          run: { font: FONT, size: 20, color: color(BRAND.ink) },
          paragraph: { spacing: { after: 120, line: 300, lineRule: D.LineRuleType.AUTO } },
        },
        title: {
          run: { font: FONT, size: 50, bold: true, color: color(BRAND.ink) },
          paragraph: { spacing: { before: 120, after: 160, line: 276, lineRule: D.LineRuleType.AUTO } },
        },
        heading1: {
          run: { font: FONT, size: 32, bold: true, color: color(BRAND.ink) },
          paragraph: { spacing: { before: 480, after: 200, line: 276, lineRule: D.LineRuleType.AUTO }, keepNext: true, keepLines: true },
        },
        heading2: {
          run: { font: FONT, size: 32, bold: true, color: color(BRAND.ink) },
          paragraph: {
            spacing: { before: 520, after: 200, line: 276, lineRule: D.LineRuleType.AUTO },
            keepNext: true,
            keepLines: true,
            border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: color(BRAND.cyan), space: 6 } },
          },
        },
        heading3: {
          run: { font: FONT, size: 23, bold: true, color: color(BRAND.ink) },
          paragraph: { spacing: { before: 320, after: 80, line: 276, lineRule: D.LineRuleType.AUTO }, keepNext: true, keepLines: true },
        },
        hyperlink: { run: { color: color(BRAND.blue), underline: { type: D.UnderlineType.SINGLE } } },
      },
      paragraphStyles: [
        {
          id: 'TableText',
          name: 'Table Text',
          basedOn: 'Normal',
          run: { size: 17 },
          paragraph: { spacing: { after: 0, line: 264, lineRule: D.LineRuleType.AUTO } },
        },
      ],
    };
  }

  function numbering(orderedStarts) {
    const indent = (level) => ({ left: 400 + level * 360, hanging: 260 });
    const bullets = {
      reference: 'pm-bullets',
      levels: [0, 1, 2].map((level) => ({
        level,
        format: D.LevelFormat.BULLET,
        text: level === 0 ? '▪' : '–',
        alignment: D.AlignmentType.LEFT,
        style: {
          paragraph: { indent: indent(level) },
          run: { font: level === 0 ? 'Arial' : FONT, color: color(level === 0 ? BRAND.cyan : BRAND.muted) },
        },
      })),
    };
    const ordered = [...orderedStarts].map((start) => ({
      reference: `pm-numbers-${start}`,
      levels: [0, 1, 2].map((level) => ({
        level,
        format: D.LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        start: level === 0 ? start : 1,
        alignment: D.AlignmentType.LEFT,
        style: {
          paragraph: { indent: { left: 400 + level * 360, hanging: 320 } },
          run: { bold: true, color: color(BRAND.blue) },
        },
      })),
    }));
    return [bullets, ...ordered];
  }

  function eyebrowRun(text) {
    return new D.TextRun({ text, bold: true, size: 15, color: color(BRAND.blue), characterSpacing: 30 });
  }

  /** Logo links, tekst rechts uitgelijnd op dezelfde regel. */
  function headerLine(logo, width, rightRuns) {
    return new D.Paragraph({
      spacing: { after: 0 },
      tabStops: [{ type: D.TabStopType.RIGHT, position: TEXT_WIDTH }],
      children: [
        new D.ImageRun({
          type: 'png',
          data: logo,
          transformation: { width, height: Math.round(width / Report.LOGO.ratio) },
          altText: { name: 'Pure Minds', title: 'Pure Minds', description: 'Logo Pure Minds' },
        }),
        ...(rightRuns.length > 0 ? [new D.TextRun({ children: [new D.Tab()] }), ...rightRuns] : []),
      ],
    });
  }

  function footer() {
    return new D.Footer({
      children: [new D.Paragraph({
        tabStops: [{ type: D.TabStopType.RIGHT, position: TEXT_WIDTH }],
        border: { top: { style: D.BorderStyle.SINGLE, size: 4, color: color(BRAND.line), space: 6 } },
        children: [
          new D.TextRun({ text: 'pure minds', bold: true, size: 15, color: color(BRAND.muted) }),
          new D.TextRun({ text: '  ·  Landingpage & Ads Optimizer', size: 15, color: color(BRAND.muted) }),
          new D.TextRun({ children: [new D.Tab(), 'pagina ', D.PageNumber.CURRENT, ' van ', D.PageNumber.TOTAL_PAGES], size: 15, color: color(BRAND.muted) }),
        ],
      })],
    });
  }

  // --- Voorblad ------------------------------------------------------------------

  function cover(title, date, meta, scores) {
    const out = [
      new D.Paragraph({ spacing: { before: 360, after: 40 }, children: [eyebrowRun(`CRO BRIEFING  ·  ${date.toUpperCase()}`)] }),
      new D.Paragraph({
        heading: D.HeadingLevel.TITLE,
        children: [
          new D.TextRun(title),
          ...(/[\p{L}\p{N}]$/u.test(title) ? [new D.TextRun({ text: '.', color: color(BRAND.cyan) })] : []),
        ],
      }),
    ];

    Report.metaItems(meta).forEach(({ label, value }) => {
      out.push(new D.Paragraph({
        spacing: { after: 40 },
        children: [
          new D.TextRun({ text: `${label.toUpperCase()}   `, bold: true, size: 15, color: color(BRAND.muted), characterSpacing: 16 }),
          new D.TextRun({ text: value, bold: true, size: 19 }),
        ],
      }));
    });

    if (scores.length > 0) {
      out.push(new D.Paragraph({ spacing: { after: 120 }, children: [] }), scoreTable(scores));
    }
    out.push(rule(360));
    return out;
  }

  /** De scores als blokken naast elkaar, met een gekleurde balk links. */
  function scoreTable(scores) {
    const gap = 227;
    const tileWidth = Math.floor((TEXT_WIDTH - gap * (scores.length - 1)) / scores.length);
    const none = { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const noBorders = { top: none, bottom: none, left: none, right: none };
    const cells = [];
    const widths = [];

    scores.forEach(({ label, value }, i) => {
      if (i > 0) {
        cells.push(new D.TableCell({ width: { size: gap, type: D.WidthType.DXA }, borders: noBorders, children: [new D.Paragraph({})] }));
        widths.push(gap);
      }
      cells.push(new D.TableCell({
        width: { size: tileWidth, type: D.WidthType.DXA },
        shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: color(BRAND.zebra) },
        borders: { ...noBorders, left: { style: D.BorderStyle.SINGLE, size: 36, color: color(TONES[Report.scoreTone(value)].solid) } },
        margins: { top: 140, bottom: 140, left: 220, right: 160 },
        children: [
          new D.Paragraph({ spacing: { after: 0 }, children: [new D.TextRun({ text: label.toUpperCase(), bold: true, size: 14, color: color(BRAND.muted), characterSpacing: 16 })] }),
          new D.Paragraph({
            spacing: { after: 0, line: 240, lineRule: D.LineRuleType.AUTO },
            children: [
              new D.TextRun({ text: Report.formatScore(value), bold: true, size: 46 }),
              new D.TextRun({ text: ' / 10', size: 20, color: color(BRAND.muted) }),
            ],
          }),
        ],
      }));
      widths.push(tileWidth);
    });

    return new D.Table({
      width: { size: TEXT_WIDTH, type: D.WidthType.DXA },
      columnWidths: widths,
      layout: D.TableLayoutType.FIXED,
      borders: { ...noBorders, insideHorizontal: none, insideVertical: none },
      rows: [new D.TableRow({ children: cells })],
    });
  }

  function rule(before = 120) {
    return new D.Paragraph({
      spacing: { before, after: 120 },
      border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: color(BRAND.line), space: 1 } },
      children: [],
    });
  }

  // --- Markdown-tokens naar Word -------------------------------------------------------

  function blocks(tokens, context) {
    const out = [];
    for (const token of tokens || []) {
      switch (token.type) {
        case 'heading':
          out.push(heading(token));
          break;
        case 'paragraph':
          out.push(paragraph(token));
          break;
        case 'text':
          out.push(new D.Paragraph({ children: token.tokens ? runs(token.tokens) : marks(Report.decode(token.text)) }));
          break;
        case 'list':
          out.push(...list(token, context));
          break;
        case 'table':
          out.push(table(token), new D.Paragraph({ spacing: { after: 120 }, children: [] }));
          break;
        case 'blockquote':
          out.push(...quote(token, context));
          break;
        case 'code':
          token.text.split('\n').forEach((line) => out.push(new D.Paragraph({
            spacing: { after: 0 },
            shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: color(BRAND.zebra) },
            children: [new D.TextRun({ text: line, font: 'Consolas', size: 17 })],
          })));
          break;
        case 'hr':
          out.push(rule());
          break;
        default:
          break; // space, html: niets te tonen
      }
    }
    return out;
  }

  /** Sectiekop met het nummer in cyaan en een cyaan lijn eronder (via de stijl). */
  function heading(token) {
    const { number, text } = Report.splitNumber(plainText(token.tokens));
    if (token.depth <= 2) {
      return new D.Paragraph({
        heading: D.HeadingLevel.HEADING_2,
        children: [...(number ? [new D.TextRun({ text: `${number}  `, color: color(BRAND.cyan) })] : []), new D.TextRun(text)],
      });
    }
    return subheading(number, text);
  }

  function subheading(number, text) {
    return new D.Paragraph({
      heading: D.HeadingLevel.HEADING_3,
      children: [...(number ? [new D.TextRun({ text: `${number}. `, color: color(BRAND.blue) })] : []), new D.TextRun(text)],
    });
  }

  /** "**1. Titel van het verbeterpunt**" op een eigen regel gedraagt zich als tussenkop. */
  function paragraph(token, options = {}) {
    const meaningful = (token.tokens || []).filter((t) => !(t.type === 'text' && !t.text.trim()));
    if (!options.inList && meaningful.length === 1 && meaningful[0].type === 'strong' && !Report.isScoreLine(token.text)) {
      const { number, text } = Report.splitNumber(plainText(meaningful[0].tokens));
      return subheading(number, text);
    }
    return new D.Paragraph({ ...options.paragraph, children: runs(token.tokens) });
  }

  function list(token, context) {
    const specs = listParagraphs(token, context, 0);
    // Ruimte na de lijst, zoals de marge onder een opsomming op het scherm.
    const isOptions = (spec) => Object.getPrototypeOf(spec) === Object.prototype;
    const last = specs.findLast(isOptions);
    if (last) last.spacing = { ...last.spacing, after: 200 };
    return specs.map((spec) => (isOptions(spec) ? new D.Paragraph(spec) : spec));
  }

  /** De alinea's van een lijst als opties, zodat de laatste nog extra ruimte kan krijgen. */
  function listParagraphs(token, context, level) {
    const start = Number(token.start) || 1;
    if (token.ordered) context.orderedStarts.add(start);
    const numberingFor = token.ordered
      ? { reference: `pm-numbers-${start}`, level: Math.min(level, 2), instance: ++context.listInstance }
      : { reference: 'pm-bullets', level: Math.min(level, 2) };

    const out = [];
    for (const item of token.items) {
      const levels = Report.parseLevels(item.text);
      if (levels) {
        out.push({ indent: { left: 400 + level * 360 }, spacing: { before: 60, after: 120 }, children: levelRuns(levels) });
        continue;
      }

      let first = true;
      for (const child of item.tokens) {
        if (child.type === 'list') {
          out.push(...listParagraphs(child, context, level + 1));
        } else if (child.type === 'text' || child.type === 'paragraph') {
          const children = child.tokens ? runs(child.tokens) : marks(Report.decode(child.text));
          out.push(first
            ? { numbering: numberingFor, spacing: { after: 60 }, children }
            : { indent: { left: 400 + level * 360 }, spacing: { after: 60 }, children });
          first = false;
        } else {
          out.push(...blocks([child], context));
        }
      }
    }
    return out;
  }

  /** "Impact: Hoog · Inspanning: Laag" als twee gekleurde labels. */
  function levelRuns(levels) {
    const out = [];
    levels.forEach(({ key, value, tone }, i) => {
      const colors = TONES[tone];
      const shading = { type: D.ShadingType.CLEAR, color: 'auto', fill: color(colors.fill) };
      if (i > 0) out.push(new D.TextRun({ text: '   ' }));
      out.push(
        new D.TextRun({ text: ` ${key} `, size: 17, color: color(colors.text), shading }),
        new D.TextRun({ text: `${value.toLowerCase()} `, size: 17, bold: true, color: color(colors.text), shading }),
      );
    });
    return out;
  }

  function table(token) {
    const columns = token.header.length;
    const matchColumn = token.header.findIndex((cell) => /^match$/i.test(cell.text.trim()));
    const texts = token.header.map((head, i) => [head.text, ...token.rows.map((row) => row[i]?.text || '')]);
    const widths = Report.columnWidths(texts, TEXT_WIDTH, { matchColumn, matchWidth: 1300 });
    const none = { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const line = { style: D.BorderStyle.SINGLE, size: 4, color: color(BRAND.line) };

    const cell = (content, i, { header = false, zebra = false } = {}) => new D.TableCell({
      width: { size: widths[i], type: D.WidthType.DXA },
      margins: { top: 70, bottom: 70, left: 100, right: 100 },
      shading: header || zebra
        ? { type: D.ShadingType.CLEAR, color: 'auto', fill: color(header ? BRAND.cyanTint : BRAND.zebra) }
        : undefined,
      borders: header ? { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: color(BRAND.cyan) } } : undefined,
      children: [new D.Paragraph({ style: 'TableText', children: content })],
    });

    return new D.Table({
      width: { size: TEXT_WIDTH, type: D.WidthType.DXA },
      columnWidths: widths,
      layout: D.TableLayoutType.FIXED,
      borders: { top: none, left: none, right: none, insideVertical: none, bottom: line, insideHorizontal: line },
      rows: [
        new D.TableRow({
          tableHeader: true,
          children: token.header.map((head, i) => cell(runs(head.tokens, { bold: true }), i, { header: true })),
        }),
        ...token.rows.map((row, r) => new D.TableRow({
          cantSplit: true,
          children: Array.from({ length: columns }, (_, i) => cell(tableCellRuns(row[i], i === matchColumn), i, { zebra: r % 2 === 1 })),
        })),
      ],
    });
  }

  function tableCellRuns(cell, isMatchColumn) {
    if (!cell) return [];
    const match = isMatchColumn && Report.matchCell(cell.text);
    if (!match) return runs(cell.tokens);
    const colors = TONES[match.tone];
    return [
      new D.TextRun({ text: ` ${match.label} `, bold: true, color: color(colors.text), shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: color(colors.fill) } }),
      ...(match.note ? [new D.TextRun(` ${match.note}`)] : []),
    ];
  }

  function quote(token, context) {
    const paragraphOptions = {
      indent: { left: 240, right: 240 },
      border: { left: { style: D.BorderStyle.SINGLE, size: 24, color: color(BRAND.cyan), space: 8 } },
      shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: color(BRAND.cyanSoft) },
    };
    return (token.tokens || []).flatMap((child) => (child.type === 'paragraph'
      ? [paragraph(child, { inList: true, paragraph: paragraphOptions })]
      : blocks([child], context)));
  }

  // --- Inline opmaak ---------------------------------------------------------------

  function runs(tokens, style = {}) {
    const out = [];
    for (const token of tokens || []) {
      switch (token.type) {
        case 'strong':
          out.push(...runs(token.tokens, { ...style, bold: true }));
          break;
        case 'em':
          out.push(...runs(token.tokens, { ...style, italics: true }));
          break;
        case 'del':
          out.push(...runs(token.tokens, { ...style, strike: true }));
          break;
        case 'codespan':
          // Placeholders als [aantal klanten invullen] vallen zo op.
          out.push(new D.TextRun({
            ...style,
            text: ` ${Report.decode(token.text)} `,
            bold: true,
            color: color(BRAND.placeholderText),
            shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: color(BRAND.placeholderFill) },
          }));
          break;
        case 'link':
          if (/^(https?:|mailto:)/i.test(token.href)) {
            out.push(new D.ExternalHyperlink({ link: token.href, children: runs(token.tokens, { ...style, color: color(BRAND.blue), underline: {} }) }));
          } else {
            out.push(...runs(token.tokens, style));
          }
          break;
        case 'br':
          out.push(new D.TextRun({ ...style, break: 1 }));
          break;
        case 'html':
          if (/^<br\s*\/?>$/i.test(token.text.trim())) out.push(new D.TextRun({ ...style, break: 1 }));
          else out.push(...marks(Report.decode(token.text), style));
          break;
        case 'text':
          out.push(...(token.tokens ? runs(token.tokens, style) : marks(Report.decode(token.text), style)));
          break;
        default:
          if (token.text) out.push(...marks(Report.decode(token.text), style));
      }
    }
    return out;
  }

  /** Match-iconen worden gekleurde tekens, net als in het document op het scherm. */
  function marks(text, style = {}) {
    return Report.splitMatches(text)
      .map((part) => (part.match
        ? new D.TextRun({ ...style, text: part.match.mark, bold: true, color: color(TONES[part.match.tone].solid) })
        : new D.TextRun({ ...style, text: part.text.replace(EMOJI, '') })))
      .filter(Boolean);
  }

  function plainText(tokens) {
    const collect = (list) => (list || []).map((token) => (token.tokens ? collect(token.tokens) : Report.decode(token.text || ''))).join('');
    return collect(tokens).replace(EMOJI, '').trim();
  }

  /**
   * Lettertypetabel van het document. Heeft de lezer Open Sans niet geïnstalleerd, dan
   * zoekt Word hier een vervanger: zonder deze gegevens kan dat een schreefletter worden,
   * nu wordt het Arial of een andere schreefloze letter.
   */
  const FONT_TABLE = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:font w:name="${FONT}"><w:altName w:val="Arial"/><w:panose1 w:val="020B0606030504020204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>` +
    '<w:font w:name="Arial"><w:panose1 w:val="020B0604020202020204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>' +
    '<w:font w:name="Consolas"><w:panose1 w:val="020B0609020204030204"/><w:charset w:val="00"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>' +
    '</w:fonts>';
})();

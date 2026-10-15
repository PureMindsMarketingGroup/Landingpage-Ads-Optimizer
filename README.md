# Landingpage & Ads Optimizer

Interne CRO-tool van Pure Minds. Hij legt een Google Ads-campagne naast de
landingspagina, beoordeelt hoe goed die op elkaar aansluiten (message match) en
maakt er een briefing van, te exporteren naar Google Docs, Word en PDF.

Plain HTML, CSS en JavaScript met één serverless function (`api/analyze.js`) op
Vercel; de API-key en de instructies voor het model staan alleen op de server.

## Online zetten (Vercel)

1. Vercel → **Add New → Project** → importeer
   `PureMindsMarketingGroup/Landingpage-Ads-Optimizer`.
2. Zet onder **Settings → Environment Variables**:

   | Variabele | |
   |---|---|
   | `ANTHROPIC_API_KEY` | Verplicht. Een key van Pure Minds uit de Anthropic Console. |
   | `SYSTEM_PROMPT` | Verplicht. De instructies voor het model. Staat bewust niet in deze repo; Pure Minds bewaart hem zelf. |
   | `APP_PASSWORD` | Optioneel. Zet de tool achter een wachtwoord. |
   | `LOG_PAGE_TEXT` | Optioneel. `false` = de paginatekst niet in de logs zetten. |

3. Deploy. Daarna deployt elke push naar `main` vanzelf.

Zonder `SYSTEM_PROMPT` start er geen analyse; de tool zegt dan wat er ontbreekt.

## Lokaal draaien

```bash
npm install
cp .env.example .env.local   # en vul de waarden in
npx vercel dev
```

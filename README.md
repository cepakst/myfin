# My finance

Lokální aplikace pro přehled investic a daní z exportů brokerů **Degiro** a **XTB**.

- Výnosy po letech v % (TWR, MWR/XIRR) i v Kč a jejich struktura: realizované a nerealizované zisky, dividendy, srážková daň, úroky a poplatky.
- Portfolio a nákupní loty (FIFO), postup k časovému testu 3 roky.
- Realizované obchody: zisk/ztráta, poplatky, doba držení.
- **Daňové přiznání – §10 (cenné papíry):** hodnoty pro Přílohu č. 2 připravené ke kopírování. Hlídá limit 100 000 Kč a časový test a nabízí volbu jednotný/denní kurz pro každý rok.
- **Dividendy (§8):** sražená daň, zápočet v ČR a částka, kterou lze vymáhat zpět v zahraničí (podle smluv o zamezení dvojího zdanění). Hodnoty pro §16a / Přílohu č. 3.
- Tipy k daňové optimalizaci: tax-loss harvesting, limit 100 000 Kč, blížící se časové testy, vratky sražené daně.
- Zajímavosti: kolik zisku snědly ztráty, ušlý potenciál prodaných akcií, nejlepší a nejhorší obchody.

Daňovou situaci (OSVČ, OSVČ v paušálním režimu, zaměstnanec, bez jiných příjmů) lze nastavit zvlášť pro každý rok.

> ⚠️ Aplikace je pomůcka, ne daňové poradenství. Před podáním přiznání si výsledky ověřte.

## Spuštění

Potřebujete [Node.js](https://nodejs.org) 22 nebo novější.

1. Spusťte **`start.bat`**. Při prvním spuštění se nainstalují závislosti, pak se aplikace sestaví a otevře v prohlížeči na <http://127.0.0.1:5174>.
2. V sekci **Nastavení a data** nahrajte exporty nebo je vložte do složky `exports/`.

### Exporty

| Broker | Co exportovat |
| ------ | ------------- |
| Degiro | *Transakce* (`Transactions.csv`) a *Výpis z účtu* (`Account.csv`), vždy za **celé období** od založení účtu |
| XTB    | *Historie účtu* – export `.zip` (nebo `.xlsx`) za celé období |

Nový export stejného typu nahradí předchozí. Starý se přesune do `exports/_archiv`.

## Soukromí

- Všechna data zůstávají v počítači, ve složkách `exports/` a `data/`. Obě jsou v `.gitignore`.
- Server poslouchá jen na `127.0.0.1`.
- Z internetu se stahují pouze kurzy ČNB a historické ceny z Yahoo Finance; posílají se jen ISIN, tickery a názvy instrumentů.

## Metodika (stručně)

- **FIFO** po brokerech. Splity, výměny (fúze, změny ISIN) i připsané akcie zachovávají datum nabytí. Akcie připsané zdarma mají pořizovací cenu 0.
- **Časový test**: prodej je osvobozen, pokud doba držení přesáhne 3 roky. Od roku 2025 platí limit 40 mil. Kč.
- **Limit 100 000 Kč**: počítají se hrubé příjmy z prodejů, které nejsou osvobozené časovým testem.
- **Kurzy**: jednotný kurz se počítá jako průměr kurzů ČNB k posledním dnům měsíců. Lze jej přepsat ručně nebo pro daný rok zvolit denní kurz. XTB obchody v CZK účtu používají skutečnou částku v Kč.
- **Výdaje** = pořizovací cena + poplatky při nákupu i prodeji (transakční poplatky, AutoFX, transakční daně).
- **Dividendy**: zápočet je nejvýše min(sražená daň, sazba dle smlouvy, 15 % z hrubé dividendy). Přeplatek nad smluvní sazbu lze reklamovat u zahraničního správce daně. České dividendy jsou zdaněny srážkou konečně.
- **Výkonnost**: TWR z denního ocenění, MWR (XIRR). Tržní ceny z Yahoo Finance; když chybí, použije se poslední obchodní cena.

## Vývoj

```bash
npm install
npm run dev        # API (tsx watch) + Vite dev server na http://localhost:5173
npm test           # Vitest (syntetická data)
npm run typecheck
npm run build && npm start
```

Struktura:

- `src/core` – parsery, FX, FIFO, daňové výpočty a analytika (čisté funkce)
- `src/server` – Fastify API, cache ČNB a Yahoo, orchestrace
- `src/web` – React + Mantine + ECharts
- `tests` – testy pouze se smyšlenými daty

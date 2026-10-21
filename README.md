# My finance

Lokální aplikace pro přehled investic a daní z exportů brokerů **Degiro** a **XTB**.

- Výnosy po letech v % (TWR, MWR/XIRR) i v Kč a jejich struktura: realizované a nerealizované zisky, dividendy, srážková daň, úroky a poplatky.
- Portfolio a nákupní loty (FIFO), postup k časovému testu 3 roky.
- Realizované obchody: zisk/ztráta, poplatky, doba držení.
- **Daňové přiznání – §10 (cenné papíry):** Příloha č. 2 (tabulka druh D, ř. 207–209 → ř. 40) připravená ke kopírování. Hlídá limit 100 000 Kč, časový test, oznámení osvobozených příjmů nad 5 mil. Kč (§38v) a nabízí volbu jednotný/denní kurz pro každý rok.
- **Dividendy (§8):** sražená daň, zápočet v ČR a částka, kterou lze vymáhat zpět v zahraničí (podle smluv o zamezení dvojího zdanění, včetně postupu pro jednotlivé státy). Pro každý rok volba: samostatný základ §16a (Příloha č. 4, ř. 401a–414 → ř. 74a), nebo obecný základ (ř. 38 + Příloha č. 3 pro každý stát). Aplikace odhadne, která varianta je výhodnější.
- Tipy k daňové optimalizaci: tax-loss harvesting, limit 100 000 Kč, blížící se časové testy, vratky sražené daně.
- Zajímavosti: kolik zisku snědly ztráty, ušlý potenciál prodaných akcií, nejlepší a nejhorší obchody.

Daňovou situaci (OSVČ, OSVČ v paušálním režimu, zaměstnanec, bez jiných příjmů) lze nastavit zvlášť pro každý rok.

> ⚠️ Aplikace je pomůcka, ne daňové poradenství. Před podáním přiznání si výsledky ověřte.

## Spuštění

Potřebujete [Node.js](https://nodejs.org) 22 nebo novější.

1. Spusťte **`start.bat`**. Při prvním spuštění se nainstalují závislosti, pak se aplikace sestaví a otevře v prohlížeči na <http://127.0.0.1:5174>.
2. V sekci **Nastavení a data** nahrajte exporty nebo je vložte do složky `exports/`.

### Desktopová aplikace (Electron)

```bash
npm run electron     # sestaví a spustí v okně aplikace
npm run dist:win     # instalátor dist-electron\My finance Setup 1.0.0.exe
```

Nainstalovaná aplikace ukládá exporty, nastavení a cache do `%APPDATA%\myfin` (podsložky `exports` a `data`).

### Exporty

| Broker | Co exportovat |
| ------ | ------------- |
| Degiro | *Transakce* (`Transactions.csv`) a *Výpis z účtu* (`Account.csv`), vždy za **celé období** od založení účtu |
| XTB    | *Historie účtu* – export `.zip` (nebo `.xlsx`) za celé období |

Nový export stejného typu nahradí předchozí. Starý se přesune do `exports/_archiv`.

## Soukromí

- Všechna data zůstávají v počítači, ve složkách `exports/` a `data/` (u nainstalované aplikace v `%APPDATA%\myfin`). Obě složky jsou v `.gitignore`.
- Server poslouchá jen na `127.0.0.1`.
- Z internetu se stahují pouze kurzy ČNB a historické ceny z Yahoo Finance; posílají se jen ISIN, tickery a názvy instrumentů.

## Metodika (stručně)

- **FIFO** po brokerech. Splity, výměny (fúze, změny ISIN) i připsané akcie zachovávají datum nabytí. Akcie připsané zdarma mají pořizovací cenu 0.
- **Časový test** (§4/1/u): prodej je osvobozen, pokud doba držení přesáhne 3 roky. Limit osvobození 40 mil. Kč se u cenných papírů uplatní jen za rok 2025 (nad limit se daní poměrná část příjmů i výdajů).
- **Limit 100 000 Kč** (§4/1/t): počítají se hrubé příjmy z prodejů, které nejsou osvobozené časovým testem.
- **Kurzy**: jednotný kurz podle GFŘ (vestavěné oficiální hodnoty 2020–2025), jinak průměr kurzů ČNB k posledním dnům měsíců. Lze jej přepsat ručně nebo pro daný rok zvolit denní kurz (v rámci roku vždy jednotně). XTB obchody v CZK účtu používají skutečnou částku v Kč.
- **Výdaje** = pořizovací cena + poplatky při nákupu i prodeji (transakční poplatky, AutoFX, transakční daně). Ztráta z prodejů CP se uplatní jen proti ziskům z CP v témže roce.
- **Dividendy**: zápočet je nejvýše min(sražená daň, sazba dle smlouvy, 15 % z hrubé dividendy); v obecném základu navíc omezen koeficientem z Přílohy č. 3. Přeplatek nad smluvní sazbu lze reklamovat u zahraničního správce daně. České dividendy a úroky XTB jsou zdaněny srážkou konečně.
- **Povinnost podat přiznání**: OSVČ vždy; zaměstnanec při jiných příjmech nad 20 000 Kč; paušální režim při příjmech §8–§10 nad 50 000 Kč; bez jiných příjmů při zdanitelných příjmech nad 50 000 Kč.
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

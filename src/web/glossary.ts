/**
 * Exact Czech definitions of every metric shown in the UI. Each text must match the computation in src/core
 * (performance.ts, insights.ts, portfolio.ts, fifo.ts, tax/*). Newlines render as paragraph breaks in hints.
 */

const ECON = 'Přepočet denním kurzem ČNB ke dni každé transakce (ekonomický pohled).';
const TAX = 'Přepočet kurzem zvoleným pro daňové účely v daném roce (jednotný nebo denní kurz ČNB – viz Daně).';
const PRICE =
  'Cena = poslední závěrečná cena z Yahoo Finance; u instrumentů bez tržních dat odhad z posledního obchodu nebo ocenění brokera (zobrazeno oranžově se znakem ≈).';

export const G = {
  // ---------- performance ----------
  value: `Tržní hodnota všech držených cenných papírů: Σ kusy × cena × kurz ČNB k datu ocenění.\n${PRICE}\nHotovost na účtech u brokerů se nezapočítává.`,
  invested:
    'Čistě investováno = Σ nákupy (vč. poplatků) − Σ čisté příjmy z prodejů (prodejní cena − poplatky).\nVklady a výběry hotovosti se neberou v úvahu – počítají se jen peníze skutečně vložené do cenných papírů.',
  pnl:
    'Celkový zisk = hodnota portfolia − čistě investováno + příjmy.\nPříjmy = dividendy po zahraniční srážkové dani (vč. vratek kapitálu) + úroky + ostatní peněžní příjmy (korporátní akce, deriváty, peněžní fondy) − poplatky účtu.\nZahrnuje realizované i nerealizované zisky a všechny poplatky; česká daň z příjmů odečtena není. ' +
    ECON,
  twr:
    'TWR (time-weighted return, časově vážený výnos) měří výkonnost samotných investic bez vlivu toho, kdy a kolik peněz jste vložili – je proto srovnatelný s indexem nebo fondem.\n' +
    'Výpočet denním řetězením: výnos dne r = (hodnota na konci dne + prodeje dne + příjmy dne) / (hodnota předchozího dne + nákupy dne) − 1; TWR = (1 + r₁) × (1 + r₂) × … × (1 + rₙ) − 1.\n' +
    'Nákupy se počítají na začátek dne, prodeje a příjmy na konec. Celkový TWR je kumulativní za celé období (není přepočten na rok). ' +
    ECON,
  xirr:
    'XIRR (peněžně vážený roční výnos, vnitřní výnosové procento) je roční sazba r, při které je součet diskontovaných peněžních toků nulový: Σ CFᵢ / (1 + r)^(dnyᵢ / 365) = 0.\n' +
    'Toky: nákupy vč. poplatků záporně; prodeje po poplatcích a příjmy (dividendy, úroky…) kladně; dnešní hodnota portfolia jako závěrečný kladný tok.\n' +
    'Na rozdíl od TWR zohledňuje načasování a velikost vašich investic – říká, jak se zhodnotily právě vaše peníze. p. a. = za rok.',
  twrVsXirr:
    'TWR a XIRR se liší, když jste investovali nerovnoměrně: pokud jste hodně nakoupili před růstem, je XIRR vyšší než TWR (a naopak). TWR hodnotí výběr investic, XIRR i načasování vkladů.',
  yearPnl:
    'Zisk roku = hodnota na konci roku − hodnota na začátku roku − nákupy + prodeje + příjmy roku (dividendy po srážce, úroky, ostatní − poplatky účtu). U běžného roku hodnota k dnešku. ' +
    ECON,
  yearTwr: 'TWR roku = hodnota indexu TWR na konci roku / hodnota na konci předchozího roku − 1 (denní řetězení jen za daný rok, viz celkový TWR).',
  yearMwr:
    'MWR (peněžně vážený výnos, v tabulce též IRR) se počítá stejně jako XIRR, jen v rámci jednoho roku: hodnota portfolia k 1. 1. jako výdaj, nákupy záporně, prodeje a příjmy kladně, hodnota na konci roku jako příjem.\n' +
    'Je přepočten na roční sazbu – u neúplného běžného roku proto může být výrazně vyšší nebo nižší než skutečný výnos za dosavadní část roku.',

  // ---------- overview ----------
  dividendsNet:
    'Součet přijatých dividend (vč. vratek kapitálu) po odečtení zahraniční srážkové daně. Případný doplatek české daně v přiznání odečten není.\n„Sraženo“ = srážková daň v Kč. ' +
    ECON,
  feesTotal:
    'Obchodní poplatky (provize, poplatky burz a transakční daně) + poplatky účtu (např. roční poplatek za připojení k burze). ' + ECON + '\nPodíl = poplatky / celkový zisk (jen při kladném zisku).',
  realizedNet:
    'Součet zisků − součet ztrát ze všech prodejů. Výsledek prodeje = (prodejní cena − poplatky prodeje) − (nákupní cena prodaných FIFO lotů + jejich nákupní poplatky).\n' +
    ECON +
    ' Daňový výsledek (jiný kurz, osvobození) je na stránce Obchody.\n„Ztráty snědly“ = součet ztrát / součet zisků.',
  taxEstimate:
    'Orientační přírůstek daně, který investice způsobí za daný rok (u běžného roku podle dosavadních obchodů):\n' +
    '• obecný základ: dílčí základ z neosvobozených prodejů CP (§10) + zdanitelné úroky, zdaněné sazbou 15 % (nad limit 23 %) navíc k „jinému základu daně“ z nastavení; bez jiných příjmů se odečte sleva na poplatníka;\n' +
    '• zahraniční dividendy: při zdanění podle §16a 15 % po zápočtu zahraniční daně (Příloha č. 4), jinak daň v obecném základu po zápočtu podle Přílohy č. 3.\n' +
    `Nejde o celkovou daňovou povinnost. Závisí na daňové situaci a „jiném základu daně“ nastavených na stránce Daně. ${TAX}`,
  mustFile: '„Přiznání podat“ = podle zvolené daňové situace musíte za rok podat daňové přiznání (podrobnosti na stránce Daně).',
  ttGain: `Čistý výsledek (zisky − ztráty) prodejů se splněným časovým testem. ${TAX}`,
  exemptGain:
    'Součet kladných výsledků všech osvobozených prodejů v roce: prodeje se splněným časovým testem, a pokud příjmy z ostatních prodejů nepřesáhly 100 000 Kč, i všechny ostatní prodeje. Do přiznání se neuvádí.',
  exemptLoss: 'Součet záporných výsledků osvobozených prodejů. Tyto ztráty nelze započíst proti zdanitelným ziskům.',
  scenarioDividends: 'Způsob zdanění zahraničních dividend: samostatný základ §16a (Příloha č. 4, 15 %) nebo obecný základ (Příloha č. 3). §16a lze volit od roku 2021.',
  scenarioBase: 'Dílčí základ z neosvobozených prodejů CP (§10) při daném přepočtu měn: příjmy − výdaje; záporný výsledek = 0 Kč.',
  scenarioSecTax: 'Přírůstek daně z dílčího základu §10 a zdanitelných úroků (15 %, nad limit 23 %) navíc k jinému základu daně; bez jiných příjmů po odečtení slevy na poplatníka.',
  scenarioTotal: 'Daň CP + daň z dividend – stejný výpočet jako „Odhad daně celkem“.',
  valueChart:
    'Denní hodnota držených cenných papírů (bez hotovosti) a čistě investovaná částka. Rozdíl křivek = celkový zisk bez dividend a dalších příjmů. Kolečkem myši nebo posuvníkem lze měnit období.',
  twrChart: 'Kumulativní časově vážený výnos (TWR) od prvního obchodu do daného dne. Výpočet viz nápověda u „Výnos (TWR) celkem“.',
  allocation: 'Podíl tržní hodnoty každé otevřené pozice na celkové hodnotě portfolia (bez hotovosti). Zobrazeno 12 největších pozic, zbytek jako „Ostatní“.',

  // ---------- years ----------
  yearsChart:
    'Rozklad zisku každého roku na složky. Kladné složky nad osou, záporné (srážková daň, poplatky) pod osou; černý bod = celkový zisk roku. ' + ECON,
  yearsPct: 'TWR = výkonnost investic nezávislá na načasování nákupů a prodejů (srovnatelná s indexem). MWR = roční výnos vašich peněz včetně vlivu načasování. Podrobnosti v tabulce níže.',
  startValue: 'Tržní hodnota portfolia k 31. 12. předchozího roku (u prvního roku 0).',
  endValue: 'Tržní hodnota portfolia k 31. 12. (u běžného roku k dnešku).',
  buys: 'Součet nákupů v roce včetně poplatků.',
  sells: 'Součet prodejů v roce po odečtení poplatků prodeje.',
  realized: 'Výsledek prodejů v roce bez poplatků: prodejní cena − nákupní cena prodaných FIFO lotů. Poplatky nákupů i prodejů jsou odečteny zvlášť v řádku „Poplatky za obchody“.',
  unrealized:
    'Dopočet: zisk roku − (realizované zisky + dividendy − srážková daň + úroky + ostatní − poplatky za obchody − poplatky účtu). Zahrnuje změnu tržní hodnoty držených pozic včetně kurzových vlivů.',
  dividendsGross: 'Hrubé dividendy a vratky kapitálu před srážkovou daní.',
  withholdingTax: 'Daň sražená z dividend v zahraničí (u CZ akcií konečná srážková daň).',
  interest: 'Úroky z hotovosti a peněžních fondů po odečtení sražené daně.',
  otherIncome: 'Hotovostní vypořádání korporátních akcí (např. zlomky akcií), výsledky derivátů a pohyby peněžních fondů – peněžní příjmy, které nejsou dividendou ani úrokem.',
  tradeFees: 'Provize, poplatky burz a transakční daně u všech nákupů a prodejů v roce.',
  accountFees: 'Poplatky nesouvisející s konkrétním obchodem, např. roční poplatek za připojení k burze.',
  divShare: '(Dividendy hrubě − srážková daň) / zisk roku. Zobrazeno jen při kladném zisku.',
  feeShare: '(Poplatky za obchody + poplatky účtu) / zisk roku. Zobrazeno jen při kladném zisku.',

  // ---------- portfolio ----------
  lotQty: 'Počet kusů lotu, které po párování prodejů metodou FIFO (nejstarší kusy se prodávají první) ještě držíte. Upraveno o splity.',
  lotCost: `Nákupní cena zbývajících kusů lotu včetně nákupních poplatků. ${ECON}\nNajetím na částku zobrazíte daňový základ (kurz zvolený pro daně).`,
  posCost: `Součet nákupních cen otevřených lotů včetně nákupních poplatků (po odečtení kusů prodaných metodou FIFO). ${ECON}`,
  posValue: `Kusy × cena × aktuální kurz ČNB. ${PRICE}`,
  price: PRICE,
  weight: 'Hodnota pozice / součet hodnot všech otevřených pozic.',
  unrealizedPos:
    'Nerealizovaný zisk = hodnota − nákupní cena vč. nákupních poplatků (ekonomicky, nákup denním kurzem ČNB). V závorce: hodnota / nákupní cena − 1. Poplatky budoucího prodeje ani daň odečteny nejsou.',
  posDividends: 'Všechny dosud přijaté dividendy z instrumentu (i za již prodané kusy) po zahraniční srážkové dani, denní kurz ČNB ke dni výplaty.',
  timeTestDate: 'Den, od kterého je prodej lotu osvobozen od daně: datum nabytí + 3 roky + 1 den (doba držení musí 3 roky přesáhnout, §4 odst. 1 písm. u ZDP).',
  timeTest:
    'Den, od kterého je prodej lotu osvobozen od daně: datum nabytí + 3 roky + 1 den (doba držení musí 3 roky přesáhnout, §4 odst. 1 písm. u ZDP). Pruh ukazuje uplynulou část lhůty; žlutě = méně než 180 dní do splnění.',
  posTimeTest: 'Kolik kusů už splnilo tříletý časový test (prodej osvobozen od daně) a kdy ho splní další lot.',

  // ---------- instrument ----------
  instValue: `Tržní hodnota držených kusů. ${PRICE}\n„Nákup“ = nákupní cena držených kusů vč. poplatků (denní kurz ČNB).`,
  instRealized:
    '„Obchody“ = součet výsledků všech prodejů instrumentu v daňovém přepočtu: (prodejní cena − poplatky) − (nákupní cena FIFO lotů + poplatky), bez ohledu na osvobození.\n„Dividendy“ = přijaté dividendy po zahraniční srážkové dani, denní kurz ČNB.',
  tradeVolume: 'Kusy × cena v měně obchodu, bez poplatků.',
  tradeFeesCol: 'Poplatky k obchodu v jejich původní měně (provize, burza, transakční daně).',
  proceedsTax: `Prodejní cena prodaných kusů (bez odečtení poplatků). ${TAX}`,
  gainTax: `(Prodejní cena − poplatky prodeje) − (nákupní cena FIFO lotu + nákupní poplatky). ${TAX}`,

  // ---------- trades ----------
  realQty: 'Počet kusů prodaných z jednoho nákupního lotu. Jeden prodej se podle FIFO může rozpadnout na více řádků (nejstarší kusy se prodávají první).',
  unitPrice: 'Cena za kus v měně obchodu (bez poplatků).',
  holding: 'Počet dní mezi nákupem (nabytím) a prodejem.',
  costsTax: `Nákupní cena FIFO lotu + nákupní poplatky + poplatky prodeje (poměrně k prodaným kusům). ${TAX}`,
  taxStatus:
    'Daňový režim prodeje: „časový test“ = drženo přes 3 roky, osvobozeno; „limit 100 tis.“ = osvobozeno, protože roční příjmy z prodejů bez časového testu nepřesáhly 100 000 Kč; „zdanitelné“ = vstupuje do §10. Podrobnosti po najetí na štítek.',

  // ---------- insights ----------
  eaten: `Ztráty / zisky – jaký podíl realizovaných zisků vymazaly realizované ztráty. Zisky a ztráty se sčítají po jednotlivých prodejních obchodech. ${ECON}`,
  feeToVolume: `Obchodní poplatky a transakční daně / celkový objem nákupů a prodejů (Σ nákupy + Σ prodeje v Kč). ${ECON}`,
  avgHoldWin:
    'Prostý průměr přes prodejní obchody se ziskem (≥ 0). Doba držení jednoho prodeje = průměr dní od nákupu do prodeje přes prodané FIFO loty, vážený počtem kusů.',
  avgHoldLoss:
    'Prostý průměr přes prodejní obchody se ztrátou. Doba držení jednoho prodeje = průměr dní od nákupu do prodeje přes prodané FIFO loty, vážený počtem kusů.',
  missed:
    'Pro každý prodaný instrument: rozdíl = dnešní hodnota prodaných kusů − příjem z prodejů po poplatcích. „Ušlý potenciál“ = součet kladných rozdílů (prodané tituly od té doby vzrostly), „uchráněno“ = součet záporných rozdílů (prodali jste včas), „netto“ = součet všech rozdílů. Jen instrumenty s tržními cenami.',
  missedReinvested:
    'Σ (dnešní hodnota prodaných kusů − reinvestice dnes), kde reinvestice dnes = příjem z prodeje po poplatcích × (index TWR portfolia dnes / index TWR v den prodeje) – odhad, kolik by dnes měly peníze z prodeje, kdyby dál vydělávaly jako celé portfolio. Kladné číslo = držet by bylo lepší.',
  insightDividends: `Přijaté dividendy po zahraniční srážkové dani (vč. vratek kapitálu). „Srážky“ = sražená daň v Kč. ${ECON}`,
  insightAccountFees: 'Poplatky nesouvisející s konkrétním obchodem, např. roční poplatek za připojení k burze.',
  gainsLossesChart: `Součet zisků a ztrát z prodejních obchodů v jednotlivých letech. Úspěšnost obchodů = podíl prodejů s výsledkem ≥ 0 (pravá osa). ${ECON}`,
  feesChart: `Obchodní poplatky a transakční daně vs. poplatky účtu po letech. ${ECON}`,
  soldQty: 'Celkem prodané kusy v okamžiku prodeje (bez úpravy o pozdější splity – ty zohledňuje až „Hodnota dnes“).',
  proceedsNet: `Příjem ze všech prodejů po odečtení poplatků prodeje. ${ECON}`,
  valueToday: 'Prodané kusy (upravené o pozdější splity) × dnešní tržní cena × dnešní kurz ČNB.',
  diff: 'Hodnota dnes − utrženo. Kladné (oranžově) = titul od prodeje vzrostl, držení by vyšlo lépe.',
  reinvested: 'Utrženo × (index TWR portfolia dnes / index TWR v den prodeje) – kolik by měly peníze z prodeje, kdyby zůstaly v portfoliu.',
  diffReinvested: 'Hodnota dnes − reinvestice dnes. Kladné (oranžově) = držet prodaný titul by vyšlo lépe než reinvestice do portfolia.',
  bestWorst: `10 prodejních obchodů s nejvyšším / nejnižším výsledkem. Zisk = (prodejní cena − poplatky) − (nákupní cena FIFO lotů + nákupní poplatky); % = zisk / (nákupní cena + nákupní poplatky). Drženo = průměr dní vážený kusy. ${ECON}`,

  // ---------- dividends ----------
  divYearsChart: 'Čistá dividenda = hrubá dividenda − srážková daň (denní kurz ČNB ke dni výplaty). Srážková daň je v daňovém přepočtu roku.',
  divCount: 'Počet výplat dividend (případně vratek kapitálu).',
  divGross: `Hrubá dividenda před srážkovou daní. ${TAX}`,
  divGrossOrig: 'Hrubá dividenda v měně výplaty. Řadí se podle částky v Kč.',
  divWithheld: 'Daň sražená při výplatě (v závorce jako % z hrubé dividendy).',
  treatyRate: 'Sazba daně podle smlouvy o zamezení dvojího zdanění mezi ČR a státem zdroje – do této výše lze zahraniční daň započíst.',
  creditable: 'Započitatelná zahraniční daň = min(sraženo; hrubě × smluvní sazba; česká daň 15 %). U států bez smlouvy 0.',
  czTax: 'Česká daň = 15 % z hrubé dividendy v daňovém přepočtu.',
  due: 'Doplatek v ČR = max(0; česká daň 15 % − započitatelná zahraniční daň). „srážka CZ“ = česká dividenda zdaněná konečnou srážkou, do přiznání se neuvádí.',
  reclaimable: 'Vratitelné = max(0; sraženo − hrubě × smluvní sazba) – daň sražená nad smluvní sazbu, o jejíž vrácení lze žádat zahraniční správce daně.',
  divNet: `Hrubě − sraženo. ${TAX}`,
  divNetDaily: `Hrubě − sraženo. ${ECON}`,

  // ---------- optimization ----------
  optValue: `Dnešní tržní hodnota kusů lotu. ${PRICE}`,
  optGain: `Daňový zisk/ztráta při prodeji dnes = hodnota − nákupní cena vč. nákupních poplatků v daňovém přepočtu. Poplatky prodeje nejsou zahrnuty.`,
} as const;

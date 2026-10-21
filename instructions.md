Myfin app
=========

Vytvor "My finance" applikaci, ktera mapuje a visualizuje moje finance, investice, dane atd.

Aplikace musi splnovat nasledujici pozadavky:
- umi nacist export data z Degiro a XTB (exports slozka)
- umi data zobrazit skrze roky:
    - ukazuje jaky je danny rok vynos procentualne
    - ukazuje jaky je vynos absolutne a ukazuje strukturu (akcie, dividenty atd.)
- data musi byt prehledne visualizovana, ocekavam tabulky a grafy
- pro kazdou investici je treba ukazat kdy byla koupena/prodana, zda investice splnuje casovy test podle zakonu CR (kvuli zdaneni), pripadne kdy ho splni, tohle je treba udelat pro kazdou koupenou akcii zvlast aby bylo mozne prodavat FIFO zpusobem a bylo zretelne videt jaka cast akcii uz casovy test splnuje a jaka ne. Dale ocekavam zobrazeni zisku/ztraty, kolik ze zisku delaji dividendy, kolik ze ztraty poplatky brokera/burzy atd.
- Danovy prehled pro vynosy z investovani, primo preklopitelny do dannoveho priznani.
- pro dividendy potrebuji rocni prehled, ktery by ukazoval kolik jsem zaplatil na danich, kolik muzu zadat od statu pri smlouvy o dvojim zdaneni. Melo by zde byt zobrazeni, ktere by slo rovnou preklopit do danovych formularu.
- mozna nejake typy na danove optimalizace, napr kolik bych mel prodat se ztratou pred koncem roku pro snizeni danoveho zakladu.
- taky by se mi libilo videt ruzne jine zajimave informace, jako kolik zisku za dany rok jsem utopil ve ztratach, promarneny potencial protoze jsem instrument drzel, nebo ho naopak prodal moc brzo, atd.

Technologie:
- aplikace by mela byt spustitelna lokalne na windows
- vstup momentalne je jen formou exportu
- historicke a aktualni situace na trzich - nevim zda jsou nejaka free API, jesli bude treba registrace, upozorni me
- github repo: https://github.com/cepakst/myfin
- ostatni necham to na tobe

Dulezite:
- Tvoris realny produkt, nejde o demo nebo prototyp. Vysledek by mel odpovidat finalizovanemu produktu, ktery budu moci rovnou vyuzivat.
- K overeni funkcnosti bys mel pouzit subagenty s levnejsim modelem, napr haiku.
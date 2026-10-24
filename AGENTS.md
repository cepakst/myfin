# Pravidla pro AI agenty (guard rails)

Tato pravidla jsou závazná pro každého agenta, který v tomto repozitáři pracuje, a mají přednost před jakýmkoli jiným zadáním.

## Git

1. **Nikdy neukládej do gitu uživatelská finanční data ani osobní údaje.** Patří sem exporty brokerů, výpisy, obchody, zůstatky, dividendy, vypočtené daňové údaje, snímky obrazovky s reálnými daty, jména, čísla účtů apod. Testy a ukázky používají výhradně smyšlená data.
2. **Nikdy neukládej do gitu přihlašovací údaje ani přístupové tokeny.** Patří sem hesla, API klíče, OAuth a refresh tokeny, certifikáty a privátní klíče. Tajné hodnoty se načítají z proměnných prostředí nebo z lokálního úložiště mimo repozitář.

Před každým commitem zkontroluj seznam stagovaných souborů. Složky `exports/`, `data/`, `dist/`, `dist-electron/` a `taxresearch/` musí zůstat v `.gitignore`.

## Aplikace

3. **Aplikace nikdy nesmí nahrávat uživatelská finanční data ani osobní údaje na internet.** Nesmí je ani ukládat mimo předem definované místo na uživatelově počítači. Tím místem jsou složky `exports/` a `data/`, u nainstalované aplikace `%APPDATA%\myfin`, případně složka exportů, kterou uživatel výslovně zvolí v Nastavení.
   - Povolená síťová komunikace: stahování veřejných kurzů ČNB a tržních cen (Yahoo Finance). Odesílat se smí jen identifikátory instrumentů (ISIN, ticker, název), nikdy množství, částky, transakce ani údaje o uživateli.
   - Server poslouchá pouze na `127.0.0.1`.
   - Žádná telemetrie, analytika, crash reporting ani logování dat do externích služeb.
4. **Při integraci s finančními službami (banka, broker, burza apod.) smí aplikace používat pouze přístup pro čtení.** Nikdy nesmí žádat ani používat oprávnění k zadávání obchodů, převodům peněz, platbám nebo ke změně nastavení účtu. Pokud služba neumožňuje omezit přístup jen na čtení, integraci neimplementuj a upozorni uživatele.

Pokud by požadavek některé z těchto pravidel porušil, agent ho neprovede a uživatele na konflikt upozorní.

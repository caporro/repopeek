# RepoPeek

App desktop locale per macOS per controllare più repository Git, gestire lo staging, creare commit e consultare le diff. Tauri 2 + Rust per il backend, React + TypeScript per l’interfaccia, WebKit di macOS per il rendering. Nessun runtime Electron o Node.js nell’app compilata.

## Avvio

Per sviluppare: Node.js 22.12+, Rust/Cargo stabile, Xcode Command Line Tools e Git disponibile in `/usr/bin/git`. Per usare l’app compilata bastano macOS e Git. Rust si installa con [rustup](https://rustup.rs/); la toolchain serve soltanto allo sviluppo.

```sh
npm ci
npm run dev
```

Per avviare la build compilata:

```sh
npm run build
npm start
```

Per creare l'app locale, senza firma di distribuzione:

```sh
npm run package
```

L'app è in `src-tauri/target/release/bundle/macos/RepoPeek.app`. La build usa l'architettura del Mac corrente. `npm run build` compila l’eseguibile senza creare il bundle; `npm start` avvia questo eseguibile. `npm run package` crea il bundle `.app` da copiare sulla macchina destinataria.

## Utilizzo

- **Aggiungi repository** / `⌘O`: selezione multipla di cartelle. Le sottocartelle vengono ricondotte alla radice Git; percorsi equivalenti e duplicati vengono rifiutati. Sono supportati anche i worktree.
- **Colonna sinistra:** elenco compatto dei repository senza percorso completo (disponibile nel tooltip del nome) con gli stessi indicatori e comandi di riordino, rinomina e rimozione. Il click su una scheda o sul nome seleziona il repository; la selezione viene salvata e ripristinata al riavvio. Le frecce, la matita e il cestino non cambiano la selezione.
- **Colonna centrale:** grafo dei commit con righe compatte da 28 px e indicatore di selezione sul bordo sinistro, corsie colorate, ramificazioni e merge, branch locali, riferimenti remoti già presenti e tag. HEAD è identificato da un indicatore accanto ai riferimenti. Il caricamento è progressivo in pagine da 20 commit, tramite scorrimento o **Carica altri commit**. Non viene eseguito alcun fetch.
- Se ci sono modifiche locali, il grafo mostra un unico nodo **WIP** sopra HEAD. Selezionandolo si vedono insieme **Working changes** e **Staged changes** nel pannello destro. I conteggi del WIP deduplicano i percorsi presenti in entrambe le sezioni.
- **Colonna destra:** dettaglio del commit selezionato con hash, titolo, autore, data, descrizione, riferimenti e albero dei file modificati. Per il WIP mostra invece le due sezioni Working/Staged e il modulo per creare un commit.
- Il click su un file apre la diff al posto del grafo centrale: elenco repository e dettaglio a destra restano visibili. **Torna al grafo** conserva selezione del commit e posizione di scorrimento. Le cartelle si espandono e si richiudono al click; le catene senza diramazioni vengono compattate.
- L'azione accanto a un file o a una cartella lo sposta da Working allo staging o viceversa. **Stage tutto** e **Unstage tutto** agiscono su tutte le modifiche della rispettiva sezione, preservando il contenuto dei file e lasciando fuori gli ignorati. Le operazioni sui singoli file vengono accodate: puoi selezionarne altri senza aspettare un refresh completo. Solo i file/cartelle coinvolti restano temporaneamente disabilitati. Lo stato Working/Staged si aggiorna dopo la conferma di Git; i conteggi delle righe del solo repository interessato vengono ricalcolati in background al termine della sequenza. Il grafo e gli altri repository non vengono ricaricati. Il commit attende che la coda sia conclusa.
- Il modulo **Commit** richiede un titolo e accetta una descrizione opzionale. Il contatore dei 72 caratteri è solo un'indicazione; il limite del messaggio completo è 10.000 caratteri. Il commit comprende soltanto le modifiche già nello staging; eventuali Working changes restano fuori. Conflitti ancora presenti disabilitano il pulsante. Le bozze restano in memoria durante il cambio di repository o di commit e si svuotano dopo un commit riuscito; non vengono salvate su disco.
- Nel riepilogo a sinistra, **✓ verde** indica HEAD allineato al tag; un **numero arancione** indica i commit successivi. Con modifiche locali si aggiunge un unico **+1 rosso**, anche quando HEAD è al tag. La spunta verde appare solo se allineato e senza modifiche. Il conteggio include i commit confluiti tramite merge. Senza tag o con repository non disponibile lo stato resta neutro.
- Riordina i repository trascinando la maniglia a puntini, con le frecce su/giù oppure usando ↑/↓ sulla maniglia. L'ordine viene salvato nel JSON locale e ripristinato al riavvio.
- I contatori di file/righe a zero sono nascosti. I conteggi delle sezioni Working/Staged mostrano anche zero per rendere esplicito lo stato dello staging.
- Se HEAD, branch locali/remoti o tag cambiano durante la paginazione, la cronologia richiede un ricaricamento per evitare salti o duplicati. Il refresh conserva il numero di pagine già caricate. Anche i repository senza commit e HEAD detached sono supportati.
- **Aggiorna** / `⌘R`: aggiorna tutti i repository. L'app aggiorna anche all'avvio e quando torna in primo piano.
- Matita: cambia soltanto il nome visualizzato. Cestino: rimuove soltanto il repository dalla lista.
- La X della finestra la chiude; `⌘Q` termina l'app. Il Dock riapre la finestra.

I contatori a destra del nome mostrano file modificati (matita), aggiunti (+ verde) e rimossi (− rosso), aggregando Staged e Working per percorso distinto. Un file presente in entrambe le sezioni conta una volta. Rinomine e conflitti rientrano nei modificati; non tracciati negli aggiunti. Un file nuovo già in staging resta un aggiunto anche se modificato o eliminato nel working; un file eliminato dallo staging e ricreato nel working conta come modificato. Il nome del repository è neutro se clean, arancione se avanti rispetto al tag, rosso se dirty o non disponibile; dirty ha precedenza su ahead.

I contatori dei commit indicano **file** modificati, aggiunti ed eliminati. I contatori delle cartelle indicano **righe** aggiunte e tolte, sommate sui file discendenti della relativa sezione. I non tracciati testuali contribuiscono con tutte le loro righe. Un asterisco segnala un totale parziale: passando sul conteggio si vede quanti file non sono conteggiabili (binari, submodule, conflitti o file non leggibili). Staged e Working sono confronti distinti, non una diff cumulativa rispetto a HEAD.

La diff di un commit confronta i blob del commit con quelli del suo genitore; per un merge si usa il **primo genitore**, per il primo commit una versione vuota. Il contenuto attuale del working tree non interviene nella preview storica.

## Dati e confini

Configurazione: `~/Library/Application Support/RepoPeek/config/settings.json`. Contiene versione del formato, percorsi, nomi personalizzati, tema e preferenze compatibili con le versioni precedenti. Il repository selezionato viene ripristinato al riavvio; il campo legacy vista lista/albero è accettato senza migrazioni. La navigazione dei file usa il tree. Le scritture sono atomiche e serializzate. Se il JSON non è leggibile viene preservato e viene mostrato il percorso da correggere; non viene sovrascritto.

Gli stati, la cronologia, i conteggi e le diff non vengono salvati. Il JSON esistente di Electron viene riutilizzato nello stesso percorso, senza migrazione distruttiva. WebKit può mantenere le proprie cache dell’interfaccia; non sono una cache degli stati Git.

React → comandi Tauri specifici → Rust → Git di sistema / lettura file. La webview non dispone di Node.js, di una shell generica o dell’accesso generico al filesystem. Ogni comando opera soltanto su repository registrati; gli argomenti di mutazione sono validati in Rust. Navigazione esterna bloccata e CSP locale. Le sole mutazioni esposte sono stage/unstage di file, cartelle o intere sezioni e commit; RepoPeek non modifica direttamente il contenuto dei file. Le letture possono procedere in parallelo; staging e commit attendono le letture in corso e sono esclusivi. Il refresh legge fino a tre repository e la cronologia fino a due commit per volta, con un massimo globale di sei processi Git. Monaco e worker sono inclusi nella build, senza CDN, e caricati soltanto alla prima diff. Nessun backend remoto.

Git usa porcelain v2 con terminatori NUL, percorsi letterali e lock opzionali disabilitati. Vengono disattivati aggiornamento automatico dell'indice, fsmonitor e lazy fetch; non vengono eseguiti diff esterni o textconv. Per Monaco si leggono i blob originali di HEAD/indice e i byte dei file locali, senza filtri smudge/textconv. Symlink: si mostra il percorso di destinazione, senza seguirlo.

## Casi particolari

| Caso                             | Comportamento                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Staged                           | Ultimo commit → indice; anche prima del primo commit.                                            |
| Working                          | Indice → file locale.                                                                            |
| Non tracciato                    | Versione vuota → contenuto locale.                                                               |
| Eliminato                        | Versione precedente → versione vuota.                                                            |
| Rinominato                       | Percorso precedente e nuovo, con confronto delle versioni corrette.                              |
| Conflitto                        | Singola voce Working; contenuto attuale con eventuali marker, senza risoluzione o diff di merge. |
| Binario / non UTF-8              | Messaggio, senza anteprima.                                                                      |
| Oltre 2 MiB per versione         | Messaggio, senza diff; lettura limitata anche se il file cresce.                                 |
| Submodule                        | Una voce per sezione interessata; riepilogo dello stato, senza lista dei file interni.           |
| Repository assente / illeggibile | Rimane nella lista come non disponibile; si riprova al refresh.                                  |
| HEAD detached                    | Mostra l'identificativo breve del commit.                                                        |
| Modifica di soli permessi / nome | Messaggio quando il contenuto è invariato.                                                       |

Niente push/pull, cambio branch, merge, rebase, reset o modifica dei file. Diff unificata, menu bar e integrazione Codex restano fuori dall'MVP.

## Verifica

```sh
npm test
npm run build
npm run test:smoke
```

I test Git lavorano esclusivamente su repository temporanei: stage/unstage di file e cartelle, commit del solo staging, staged/working, cronologia su branch locali e remoti, diff dei commit solo remoti, invalidazione delle pagine dopo cambi dei riferimenti, tag, primo commit, merge, preview storiche indipendenti dal working tree, conteggi delle righe, rinomine, nomi speciali, conflitti, symlink, binari, limiti, worktree, submodule e integrità delle operazioni di lettura. I test del tree verificano compattazione e aggregazione senza doppio conteggio. I test del grafo verificano corsie, WIP, merge e continuità durante la paginazione. I test JSON verificano persistenza, concorrenza e preservazione della configurazione corrotta.

`npm test` compila un driver Rust senza GUI e riutilizza i test Git/JSON esistenti contro il backend nativo. I test del tree e del grafo restano in TypeScript. Il driver non è incluso nel bundle desktop. `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib --locked` verifica inoltre che le letture siano concorrenti e le scritture esclusive.

`npm run build:ui` verifica TypeScript e compila l’interfaccia. `npm run test:smoke` compila l’interfaccia e una variante nativa con la feature opzionale `smoke`, la avvia con un profilo e repository temporanei e verifica direttamente nella WKWebView le tre colonne, paginazione, Monaco, stage/unstage dalla UI, commit del solo staging, diff storiche, preferenze e validazione dei percorsi. Non accede ai repository personali. Le normali cancellazioni Monaco alla chiusura dell’editor sono conteggiate separatamente dagli errori JS. L’iniezione dei test e il comando che salva il rapporto esistono soltanto nella variante `smoke`, esclusa da `npm run package`. Lo smoke non automatizza il selettore cartelle, le scorciatoie di macOS o il riavvio dal Dock: questi richiedono anche una verifica manuale.

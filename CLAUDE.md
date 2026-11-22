# APEX NOCTURNE — guide du projet

Jeu de course de rue nocturne en monde ouvert, jouable dans le navigateur. Jeu **original**
(titre, ville « Port-Sélène », voitures et marques fictives) dans l'esprit des jeux de tuning
des années 2000. **100 % procédural** : aucun asset externe (ni modèle 3D, ni texture, ni son).

Stack : Vite 8 · React 19 · TypeScript 7 (strict) · Tailwind CSS 4 · Three.js r187 · lucide-react.

## Commandes

```bash
npm install          # dépendances
npm run dev          # serveur de dev → http://localhost:5173
npm run typecheck    # npx tsc --noEmit
npm run build        # tsc --noEmit puis vite build → dist/
npm run preview      # sert dist/ → http://localhost:4173
```

Paramètres d'URL utiles : `?quality=low|medium|high` force la qualité graphique
(`low` = sans bloom, pixel ratio 1 — pratique pour les machines modestes ou le rendu logiciel).

## Contrôles

| Touche | Action |
| --- | --- |
| `Z` `Q` `S` `D` ou flèches | Accélérer / tourner / freiner (marche arrière à l'arrêt) |
| `Espace` | Frein à main (déclenche les drifts) |
| `Maj` ou `N` | Nitro (NOS) |
| `E` | Entrer dans une course / le garage (près d'un portail néon) — rapport **+** en boîte manuelle |
| `A` | Rapport **−** en boîte manuelle (`PageUp` / `PageDown` fonctionnent aussi) |
| `G` | Bascule boîte automatique / manuelle |
| `V` | Change de caméra : poursuite rapprochée → poursuite éloignée → capot |
| `C` | Regarder derrière (maintenir) |
| `T` | Rétroviseur virtuel on/off |
| `M` | Carte du monde (GPS, voyage rapide, lancement d'épreuve) |
| `R` | Replacer la voiture sur la route |
| `Échap` / `P` | Pause (options, commandes, statistiques) |

Les touches sont lues par **code physique** (`KeyW/A/S/D`) : ZQSD sur AZERTY et WASD sur QWERTY
fonctionnent sans réglage. Une manette « standard » est aussi reconnue (gâchettes, stick gauche,
A = frein à main, X = nitro, LB/RB = rapports).

## Architecture

```
src/
├─ core/                 Contrats et utilitaires partagés (aucune dépendance de jeu)
│  ├─ types.ts           ★ LE contrat d'intégration : toutes les interfaces inter-modules
│  ├─ layout.ts          Plan directeur de Port-Sélène (périphérique, quartiers, tunnel, pont, garage)
│  ├─ path.ts            PolylinePath : polyligne paramétrée par abscisse curviligne (routes, GPS, IA)
│  ├─ math.ts            clamp / damp / angles / PRNG mulberry32 / formatage
│  └─ renderSetup.ts     Renderer WebGL + post-traitement (bloom) partagés par le jeu et les bancs d'essai
├─ physics/
│  ├─ vehiclePhysics.ts  Modèle arcade : couple moteur, boîte 6 rapports auto/manuelle, transfert de
│  │                     masse, pneus (drift), nitro, turbo, sauts, dégâts
│  ├─ vehicleConfig.ts   buildVehicleConfig / estimateStats (spec catalogue + tuning → paramètres)
│  └─ collision.ts       Cercles vs boîtes orientées, voiture↔voiture, voiture↔trafic
├─ audio/
│  └─ engineSound.ts     Synthétiseur Web Audio : moteur (harmoniques par cylindrée), turbo/blow-off,
│                        pneus, nitro, sirènes, hélicoptère, impacts, sons d'interface, musique
├─ world/
│  ├─ cityGenerator.ts   generateCity() → CityWorld : assemble les modules de city/
│  ├─ city/              terrain + champ de hauteur, plan et graphe routier (A*), routes, quartiers,
│  │                     structures (tunnel, pont, rampes, garage), mobilier, brise-poursuites,
│  │                     collisions (grille spatiale), ciel et ambiance
│  ├─ vehicleModels.ts   Modèles procéduraux : 7 voitures personnalisables, police, trafic, hélicoptère
│  ├─ models/            Carrosseries paramétriques, jantes, matériaux (peintures), textures générées
│  ├─ effects.ts         Particules, traces de pneus, portails, checkpoints, herses, barrières
│  ├─ garageScene.ts     Showroom du garage (scène Three.js séparée)
│  └─ environment.ts     Environment map nocturne (reflets sur carrosserie et asphalte mouillé)
├─ ai/
│  ├─ aiDrivers.ts       Point d'entrée : createRaceAI, createPoliceSystem
│  ├─ raceAI.ts          Pilotes rivaux : trajectoire, vitesse en virage, dépassements, rubber-banding
│  ├─ police.ts          Police : Heat 1-5, tactiques, barrages, herses, hélicoptère,
│  │                     évasion / cooldown / arrestation
│  ├─ steering.ts        Briques communes de pilotage (poursuite de point, pédales, palpeurs)
│  └─ traffic.ts         Trafic civil cinématique sur les voies du graphe routier
├─ game/
│  ├─ GameEngine.ts      ★ Chef d'orchestre : boucle, physique à pas fixe, collisions, caméras,
│  │                     rétroviseur, garage, pont GameAPI vers l'interface
│  ├─ gameModes.ts       Progression ($, REP, garage, sauvegarde localStorage) + RaceSession
│  │                     (sprint, circuit, drift, drag, radar)
│  ├─ events.ts          Catalogue des 17 épreuves + construction des tracés sur le graphe routier
│  ├─ catalog.ts         Données : voitures, niveaux de tuning, options visuelles, prix, niveaux de REP
│  ├─ streetLife.ts      Frôlements, aspiration, sauts, combos de drift en balade, excès de vitesse
│  ├─ cameraRig.ts       Caméras (3 vues, regard arrière, rétroviseur, orbites titre/garage)
│  ├─ input.ts           Clavier (codes physiques) + manette
│  └─ store.ts           UIStore (état basse fréquence) + Telemetry (haute fréquence, mutable)
├─ components/           Interface React (HUD, garage, carte, menus) — ne dépend que de GameAPI
│  ├─ GameUI.tsx         Racine de l'interface
│  ├─ RaceHUD.tsx        HUD de conduite (compteurs, radar, course, poursuite)
│  ├─ GarageModal.tsx    Garage : voitures, performances, style
│  └─ WorldMapOverlay.tsx Carte du monde interactive
└─ App.tsx               Canvas plein écran + <GameUI api={engine.api} />
dev/                     Bancs d'essai servis par `npm run dev` (hors build de production) :
                         /dev/city-preview.html, /dev/city-map.html, /dev/models-preview.html,
                         /dev/ui-playground.html (API simulée), /dev/audio-test.html
```

### Conventions (voir l'en-tête de `src/core/types.ts`)

- Unités SI : mètres, secondes, radians, kg. Vitesses en m/s sauf champs suffixés `Kmh`.
- Repère : **+X = est, +Y = haut, +Z = sud**. Les cartes dessinent X vers la droite, Z vers le bas.
- Cap `h` : `forward = (sin h, 0, cos h)`, `right = (-cos h, 0, sin h)`. Un modèle dont l'avant est
  en +Z local s'oriente avec `rotation.y = h`. Cap d'une direction : `atan2(dx, dz)`.
- Direction : `steer` −1 = gauche, +1 = droite ; tourner à droite **diminue** le cap.
- Pas d'`enum` TypeScript (unions de chaînes), `import type` obligatoire (`verbatimModuleSyntax`).

### Boucle de jeu (`GameEngine.frame`)

1. `requestAnimationFrame` → `dt` réel borné (≤ 0,1 s ; ≤ 1/15 s pour la simulation).
2. **Physique à pas fixe 120 Hz** (accumulateur, 10 sous-pas max) : `IVehicle.update(1/120, input)`
   pour chaque véhicule (joueur, rivaux, police), puis collisions véhicule↔véhicule et
   véhicule↔trafic (`resolveVehiclePair`, `resolveVehicleVsBody`).
3. Une fois par image : événements véhicules (son, particules, UI) → trafic → session de course →
   police → scoring de rue → vidage des files d'événements.
4. Synchronisation visuelle (modèles, particules, caméra), audio, écriture de la télémétrie, rendu
   (scène → bloom → tone mapping), rétroviseur (cible de rendu réinjectée en miroir).

L'interface React est **découplée** : le moteur publie un `UIState` immuable (basse fréquence, via
`useSyncExternalStore`) et mute en place un objet `Telemetry` que le HUD lit dans sa propre boucle
`requestAnimationFrame` pour mettre à jour le DOM de façon impérative (jamais de state React à 60 Hz).

### Modèle physique (`vehiclePhysics.ts`)

Modèle « bicyclette » arcade dans le repère voiture : angles de dérive avant/arrière, courbe de pneu
saturante, transfert de masse longitudinal, cercle d'adhérence, appui aérodynamique. Le drift se
déclenche au frein à main, à la puissance (propulsions) ou par transfert de masse ; une assistance
(amortissement de lacet + contre-braquage partiel) le rend tenable au clavier. `buildVehicleConfig`
applique exactement les tables `TUNE_EFFECTS` de `catalog.ts` ; `estimateStats` alimente les barres
du garage. La hauteur du sol vient de `CityWorld.getGroundHeight` (relief, pont, rampes → sauts).

### Monde (`cityGenerator.ts`)

`generateCity()` construit en une passe : champ de hauteur (collines à l'ouest), graphe routier
(`RoadGraph` : nœuds, arêtes, A*), périphérique « L'Orbitale » avec tunnel et pont, quatre quartiers
(Néon Central, Quartier Lanterne, Docks de Ferraille, Hauts-de-Sélène), collisions par grille
spatiale, rampes de saut, brise-poursuites destructibles, données 2D pour la carte.

### Épreuves et progression

Les épreuves (`events.ts`) sont décrites par des points de passage ; `buildEvent` les projette sur le
graphe routier (A* entre points), arrondit les angles et place grille de départ, checkpoints et radars.
`RaceSession` gère compte à rebours, tours, classement, scoring de drift (angle × vitesse × combo,
bonus de proximité des murs), drag (boîte manuelle forcée, zone verte, température moteur) et radars.
La sauvegarde (`localStorage`, clé `apex-nocturne-save-v1`) contient argent, REP, garage, records,
statistiques et options.

### Poursuites

`IPoliceSystem` (ai/aiDrivers.ts) : patrouilles ambiantes, déclenchement sur infraction vue, Heat 1→5
(patrouilles → intercepteurs → SUV / PIT, barrages, herses, hélicoptère), jauges évasion / cooldown /
arrestation. Les brise-poursuites (`CityWorld.pursuitBreakers`) se déclenchent en percutant leur point
faible à haute vitesse et neutralisent les unités dans la zone de chute.

## Règles de contribution

- `src/core/types.ts` est le contrat entre modules : toute modification d'interface doit être
  répercutée chez tous les consommateurs. L'UI ne doit importer que `core/` et `game/catalog.ts`.
- Zéro asset externe : géométrie en code, textures `CanvasTexture`, sons Web Audio.
- Pas d'allocation dans les chemins chauds (physique, IA, particules, HUD).
- Vérifier avant de livrer : `npx tsc --noEmit` et `npm run build`.
- Outils de debug : `window.__apex` (état joueur, `fastForward(s)` = simulation sans rendu,
  `setAutopilot(on, nitro, gLatéral, gFreinage)` = pilote de test qui suit le tracé de l'épreuve en
  cours, `setAutopilotRoute('ring', kmh)` = le fait tourner sur le périphérique en balade (utile
  pour tester les poursuites), `setInput({...})` / `clearInput()`, `teleport(x, z, cap)`,
  `addMoney`, `addRep`, `renderInfo()`).

## Points connus

- Les performances n'ont été mesurées qu'en rendu logiciel (Chromium headless) ; sur une machine
  modeste, passer la qualité sur « medium » ou « low » dans les options (bloom et résolution).
- En peloton serré avec du trafic, les rivaux peuvent s'accrocher dans le premier virage.
- L'équilibrage n'a été réglé qu'avec le pilote de test (qui suit l'axe de la route) : drag et sprints
  de niveau 1-2 sont gagnables avec la voiture de départ ; les circuits restent à valider à la main.
  Leviers : `RIVAL_SKILL`, `RUBBER_BAND`, `EASY_CUSHION` (gameModes.ts) et `RACE_TUNING` (ai/raceAI.ts).
- Les roues du trafic civil ne tournent pas (géométrie fusionnée pour limiter les draw calls).

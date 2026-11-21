/* Key list shown on the title screen and in the pause menu (the ENGINE owns these bindings). */
export interface ControlLine {
  keys: string;
  action: string;
}

export const CONTROLS: ControlLine[] = [
  { keys: 'ZQSD / Flèches', action: 'Conduire' },
  { keys: 'Espace', action: 'Frein à main' },
  { keys: 'Maj / N', action: 'Nitro' },
  { keys: 'E', action: 'Entrer (course, garage)' },
  { keys: 'M', action: 'Carte' },
  { keys: 'V', action: 'Caméra' },
  { keys: 'C', action: 'Regarder derrière' },
  { keys: 'T', action: 'Rétroviseur' },
  { keys: 'R', action: 'Replacer la voiture' },
  { keys: 'G', action: 'Boîte auto/manuelle' },
  { keys: 'A / E', action: 'Rapport − / + (manuelle)' },
  { keys: 'Échap / P', action: 'Pause' },
];

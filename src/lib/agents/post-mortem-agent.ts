/**
 * Agent post-mortem - analyse des erreurs après résolution
 *
 * Déclenché après la résolution d'un marché sur lequel une position
 * a été prise. Compare la prédiction initiale de l'agent concerné
 * au résultat réel, identifie les biais systématiques (sur/sous-
 * confiance, mauvaise source de données, fenêtre temporelle inadaptée…),
 * et génère un rapport structuré stocké en base.
 * Ces rapports alimentent un processus d'ajustement des paramètres
 * des agents au fil du temps.
 */

export {};

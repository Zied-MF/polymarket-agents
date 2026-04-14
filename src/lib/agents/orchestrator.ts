/**
 * Orchestrateur - allocation du capital entre agents
 *
 * Point d'entrée central du système multi-agents.
 * Reçoit la liste des marchés éligibles, détermine quel(s) agent(s)
 * spécialisé(s) est compétent pour chacun, collecte leurs recommandations
 * (direction + confiance), applique le Kelly Criterion pour dimensionner
 * les mises, puis émet les ordres via l'API CLOB.
 * Assure également la gestion du risque global : plafond par marché,
 * exposition totale du portefeuille, corrélation entre positions.
 */

export {};

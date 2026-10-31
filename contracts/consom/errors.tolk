// Codes d'erreur de l'émetteur ConsoM (plage 400-499, pour ne pas croiser ceux du wallet Jetton).

const ERR_PAUSED              = 400   // émetteur en pause
const ERR_WRONG_NETWORK       = 401   // bon signé pour un autre réseau
const ERR_WRONG_MINTER        = 402   // bon signé pour un autre contrat
const ERR_EXPIRED             = 403   // bon expiré
const ERR_VALIDITY_TOO_LONG   = 404   // expiration à plus de 7 jours
const ERR_BAD_SIGNATURE       = 405   // signature invalide
const ERR_SAME_WITNESS        = 406   // deux signatures du même témoin
const ERR_BAD_WITNESS_INDEX   = 407   // témoin inexistant
const ERR_NOT_RECIPIENT       = 408   // le bon n'est pas envoyé par son bénéficiaire
const ERR_UNKNOWN_KIND        = 409   // type de bon inconnu
const ERR_WINDOW_CLOSED       = 410   // hors de la fenêtre de la catégorie (avant T0, prévente > 18 mois, récompenses > 24 mois)
const ERR_WRONG_AMOUNT        = 411   // montant différent de celui que le contrat recalcule
const ERR_CATEGORY_CAP        = 412   // plafond de la catégorie atteint
const ERR_DAILY_CAP           = 413   // plafond journalier global atteint
const ERR_SUPPLY_CAP          = 414   // offre maximale de 250 M dépassée (ne doit jamais arriver)
const ERR_POINTS_TOO_HIGH     = 415   // Points supérieurs à P_max × montant payé
const ERR_NOT_ENOUGH_TON      = 416   // TON joint insuffisant
const ERR_BURN_NOT_ALLOWED    = 417   // brûlage refusé : seul le programme de conversion (la banque) peut détruire des ConsoM
const ERR_NOT_GUARDIAN        = 420   // réservé au gardien
const ERR_PAUSE_TOO_SOON      = 421   // une pause a déjà commencé dans les 30 derniers jours
const ERR_REPLACE_TOO_SOON    = 422   // un témoin a déjà été remplacé dans les 30 derniers jours
const ERR_REPLACE_PENDING     = 423   // un remplacement est déjà en attente
const ERR_NO_PENDING          = 424   // aucun remplacement en attente
const ERR_TIMELOCK            = 425   // délai de 7 jours non écoulé
const ERR_DUPLICATE_KEY       = 426   // la nouvelle clé est déjà celle d'un témoin
const ERR_ZERO_KEY            = 427   // clé de témoin vide (zéro) : refusée au déploiement et dans un remplacement
const ERR_NOT_CHILD           = 430   // message qui ne vient pas d'un budget ou d'un compte membre de cet émetteur
const ERR_NOT_WALLET          = 431   // notification de brûlage qui ne vient pas d'un wallet ConsoM
const ERR_NOT_BANK            = 432   // message réservé à la banque d'échange
const ERR_GENESIS_DONE        = 440   // genèse déjà faite
const ERR_GENESIS_NOT_DONE    = 441   // réclamation d'un Ancien Contributeur avant la genèse (les parts à attribuer n'existent pas encore)
const ERR_NOTHING_TO_RELEASE  = 442   // part de l'équipe : rien de nouveau à libérer
const ERR_NO_FOUNDER_SHARES   = 443   // réclamation d'un Ancien Contributeur : pas assez de parts à attribuer dans la banque
const ERR_EARLY_TOTAL         = 444   // contributions du lancement anticipé : au-delà du total gravé au déploiement

// Contrôles au déploiement (A3, A16) : un contrat dont les données gravées ne respectent pas ces règles refuse tout message
const ERR_DEPLOY_SAME_KEYS      = 480   // deux des 3 clés de témoins sont identiques
const ERR_DEPLOY_NO_GUARDIAN    = 481   // adresse du gardien vide
const ERR_DEPLOY_NO_TEAM        = 482   // adresse de l'équipe vide
const ERR_DEPLOY_GUARDIAN_SYSTEM = 483  // le gardien ne peut pas être l'émetteur ni la banque
const ERR_DEPLOY_TEAM_SYSTEM    = 484   // l'équipe ne peut pas être l'émetteur ni la banque
const ERR_DEPLOY_TEAM_FORBIDDEN = 485   // l'adresse de l'équipe figure dans la liste des adresses interdites de réception
const ERR_DEPLOY_FORBIDDEN_LIST = 486   // liste interdite : plus de 8 adresses, ou une adresse vide
const ERR_UNKNOWN_OP          = 0xFFFF

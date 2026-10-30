// Constantes de l'émetteur ConsoM. Chaque valeur renvoie à la spécification (docs/SPECIFICATION.md).
// Tous les montants sont en unités de base : 1 ConsoM = 10^9 unités (9 décimales, standard Jetton).

const ONE_CONSOM = 1000000000

// ---------- Section 3 : plafonds par catégorie (gravés au déploiement) ----------
const CAP_PRESALE  = 100000000 * ONE_CONSOM
const CAP_PURCHASE = 55000000 * ONE_CONSOM
const CAP_REFERRAL = 45000000 * ONE_CONSOM
const CAP_MISSIONS = 19900000 * ONE_CONSOM    // premier achat et missions
const CAP_FOUNDERS = 5000000 * ONE_CONSOM     // Anciens Contributeurs
const CAP_TEAM     = 5000000 * ONE_CONSOM
const CAP_CHIKA    = 20000000 * ONE_CONSOM    // réserve à part du Bonus CHIKA
const CAP_FOUNDATION = 100000 * ONE_CONSOM    // réserve de la Fondation (A13) : créée à la genèse dans un stock à part de la banque
const MAX_SUPPLY   = 250000000 * ONE_CONSOM

// Part des Anciens Contributeurs déposée dans la banque à la genèse : 70 % de 5 M
const FOUNDERS_BANK_DEPOSIT = 3500000 * ONE_CONSOM

// Anciens Contributeurs (A8) : 30 % de leur part sont créés pour eux, 70 % leur sont attribués en parts de la banque.
// La part totale T d'un bon doit être un multiple de 10 unités de base : les deux morceaux sont alors exacts
// et la somme de toutes les réclamations ne peut pas dépasser 5 000 000 (1 500 000 créés + 3 500 000 de parts).
const FOUNDER_DIRECT_BP = 3000     // 30 % de T créés directement
const FOUNDER_UNIT      = 10       // T est un multiple de 10 unités de base

// Catégories (index dans Caps)
const CAT_PRESALE  = 0
const CAT_PURCHASE = 1
const CAT_REFERRAL = 2
const CAT_MISSIONS = 3
const CAT_FOUNDERS = 4
const CAT_TEAM     = 5
const CAT_CHIKA    = 6
const CAT_FOUNDATION = 7
// Contributions du lancement anticipé : même réserve que la prévente (CAT_PRESALE), mais suivie à part par l'émetteur
// pour que la règle des invendus et la retenue gravée (earlyHold) s'y appliquent correctement
const CAT_EARLY    = 8

// ---------- Section 5 : types de bon ----------
const KIND_PRESALE         = 0   // pack de prévente                  -> budget de paiement
const KIND_PURCHASE_RECORD = 1   // enregistre les Points d'un achat   -> budget de paiement (montant 0)
const KIND_REFERRAL        = 2   // parrainage niveau 1 à 5            -> budget de paiement
const KIND_FIRST_PURCHASE  = 3   // bonus de 1er achat                 -> budget de paiement
const KIND_CONVERSION      = 4   // 5 % des Points convertis           -> compte membre
const KIND_MISSION_TG      = 5   // mission Telegram                   -> compte membre
const KIND_MISSION_FB      = 6   // mission Facebook                   -> compte membre
const KIND_INVESTMENT      = 7   // 0,04 ConsoM par CHIKA investi      -> compte membre, réserve Achats
const KIND_BANK_CONVERSION = 8   // conversion via la banque : la banque brûle sur son stock (aucune création)
const KIND_OWN_CONVERSION  = 9   // conversion avec ses propres ConsoM : arrive par la banque, jamais par ClaimVoucher
const KIND_CHIKA_BONUS     = 10  // bonus de 0,3 % d'une commande payée en CHIKA -> budget de paiement, réserve CHIKA
const KIND_FOUNDER_CLAIM   = 11  // réclamation d'un Ancien Contributeur -> compte membre, réserve Anciens Contributeurs
const KIND_EARLY_CONTRIBUTION = 12  // contribution du lancement anticipé (réseau d'essai) -> budget (une fois par contribution), réserve de prévente
const KIND_MAX             = 12

// ---------- Section 6 : montants des récompenses ----------
const FIRST_PURCHASE_REWARD = 500 * ONE_CONSOM
const MISSION_REWARD        = 150 * ONE_CONSOM
const CONVERSION_RATE_BP    = 500    // 5 % des Points convertis
const INVESTMENT_RATE_BP    = 400    // 0,04 ConsoM par CHIKA investi
const INVESTMENT_LIMIT_BP   = 3000   // total des bonus d'investissement <= 30 % des Points attestés cumulés du membre
const REFERRAL_L1_BP        = 250    // 2,5 %
const REFERRAL_L2_BP        = 130    // 1,3 %
const REFERRAL_L3_BP        = 70     // 0,7 %
const REFERRAL_L4_BP        = 40     // 0,4 %
const REFERRAL_L5_BP        = 10     // 0,1 %
const CHIKA_BONUS_BP        = 30     // 0,3 % du montant payé en CHIKA (3 ConsoM pour 1 000 FCFA)
const BP_DENOMINATOR        = 10000

// Section 4 : P_max = 0,5 Point par FCFA payé, soit 2 × Points <= montant payé
const P_MAX_DENOMINATOR = 2

// ---------- Section 7 : packs de prévente (ConsoM, prix minimum en FCFA) ----------
const PACK_ESSENTIEL_CONSOM = 3000 * ONE_CONSOM
const PACK_ESSENTIEL_PRICE  = 3500
const PACK_POPULAIRE_CONSOM = 20000 * ONE_CONSOM
const PACK_POPULAIRE_PRICE  = 17500
const PACK_GRANDE_CONSOM    = 50000 * ONE_CONSOM
const PACK_GRANDE_PRICE     = 38000

// ---------- Durées ----------
const ONE_DAY   = 86400
const ONE_MONTH = 30 * ONE_DAY
const ONE_YEAR  = 365 * ONE_DAY
const PRESALE_WINDOW = 18 * ONE_MONTH    // la prévente se ferme à T0 + 18 mois (et la règle des invendus se déclenche)
const REWARDS_WINDOW = 24 * ONE_MONTH    // les récompenses s'arrêtent à T0 + 24 mois
const VOUCHER_MAX_VALIDITY = 7 * ONE_DAY

// ---------- Réserve de la Fondation (A13) : 100 000 ConsoM sous clé, jamais brûlés ----------
const FOUNDATION_RESERVE     = CAP_FOUNDATION   // créés une seule fois, à la genèse, dans le stock « Fondation » de la banque
const FOUNDATION_EMPTY_DELAY = ONE_MONTH        // banque vide 30 jours de suite (et au moins T0 + 24 mois) : la réserve s'ouvre

// ---------- Part de l'équipe (A9) : 5 000 000, rien avant 12 mois, puis 1/24 par période de 30 jours ----------
const TEAM_CLIFF   = 12 * ONE_MONTH    // rien n'est libéré avant T0 + 12 mois
const TEAM_PERIODS = 24                // 24 périodes de 30 jours : tout est libéré à T0 + 36 mois

// ---------- Section 10 : sécurité ----------
const GLOBAL_DAILY_CAP        = 2000000 * ONE_CONSOM   // émission maximale par 24 h, prévente comprise
const PAUSE_MAX_DURATION      = 14 * ONE_DAY
const PAUSE_MIN_INTERVAL      = ONE_MONTH              // une seule pause commencée par 30 jours
const WITNESS_TIMELOCK        = 7 * ONE_DAY
const WITNESS_REPLACE_INTERVAL = ONE_MONTH             // un remplacement de témoin par 30 jours
const WITNESS_COUNT           = 3

// ---------- Section 8 : halving ----------
// un palier tous les 15 000 000 ConsoM brûlés par les conversions, 16 divisions au plus (17 paliers)
const HALVING_STEP      = 15000000 * ONE_CONSOM
const HALVING_MAX_STEPS = 16
// brûlage (unités de base) pour P Points avec n paliers = ceil(P × 10^8 / 2^n)  (V = 100 au départ)
const BURN_PER_POINT_NUMERATOR = 100000000

// ---------- Frais (TON) ----------
const MIN_CLAIM_VALUE     = ton("0.25")   // un bon traverse 3 contrats avant la création des jetons
const MINT_TON_VALUE      = ton("0.05")   // TON joint à une création de jetons (le reste revient au membre)
const BANK_NOTIFY_VALUE   = ton("0.02")   // TON transmis à la banque avec un dépôt (notification)
const MIN_STORAGE_RESERVE = ton("0.05")
const TEAM_RELEASE_MIN_VALUE   = ton("0.1")    // TON joint à « libérer la part de l'équipe » (l'excédent revient à l'appelant)
const FOUNDATION_MINT_VALUE    = ton("0.1")    // TON joint à la création de la réserve de la Fondation, à la genèse
const BANK_RESULT_VALUE        = ton("0.01")   // TON joint au résultat d'une conversion envoyé à celui qui a présenté le bon
// Un message envoyé avec une valeur fixe NE diminue PAS la valeur « restante » du message reçu : un second message qui emporte le
// reste (mode 64) la dépenserait une deuxième fois, sur le solde de l'émetteur. Quand l'émetteur envoie deux messages, le dernier
// reçoit donc une valeur calculée (reçu - déjà envoyé - marge) ; la marge couvre le calcul de l'émetteur, le reste lui revient.
const MINTER_GAS_MARGIN        = ton("0.03")
const MIN_GENESIS_VALUE        = ton("0.25")   // genèse : deux créations dans la banque
const EARLY_BANK_MINT_VALUE    = ton("0.15")   // TON joint à la création des 70 % dans la banque (contribution du lancement anticipé)
const EARLY_BANK_FWD_VALUE     = ton("0.1")    // dont transmis à la banque, qui crédite les parts (et déploie le contrat « parts »)
const MIN_EARLY_CLAIM_VALUE    = ton("0.45")   // une contribution traverse budget et compte membre, puis crée deux montants
const BANK_ASSIGN_VALUE        = ton("0.05")   // TON transmis à la banque pour attribuer les parts d'un Ancien Contributeur
const MIN_FOUNDER_CLAIM_VALUE  = ton("0.35")   // réclamation d'un Ancien Contributeur : MIN_CLAIM_VALUE + BANK_ASSIGN_VALUE

// ---------- Compte membre (section 6) ----------
const MEMBER_DAILY_CAP   = 50000 * ONE_CONSOM   // reçu par membre et par 24 h, hors prévente
const POINTS_VALIDITY    = 7 * ONE_DAY          // les Points d'un achat se convertissent dans les 7 jours, sinon ils sont perdus
const POINTS_BUCKET      = 3600                 // Points regroupés par heure d'expiration (arrondie vers le bas : jamais plus de 7 jours)

// ---------- Raisons de refus (ClaimRejected.reason) ----------
const REJECT_SLOT_USED          = 1   // budget : cette récompense a déjà été versée pour ce paiement
const REJECT_PAYMENT_MISMATCH   = 2   // budget : montant ou Points différents de ceux déjà attestés pour ce paiement
const REJECT_PRESALE_EXCLUSIVE  = 3   // budget : un paiement de prévente ne donne pas d'autre récompense (et inversement)
const REJECT_WRONG_OWNER        = 10  // membre : le bon n'est pas pour l'adresse liée au compte
const REJECT_NOT_ELIGIBLE       = 11  // membre : récompense demandée sans participation à la prévente
const REJECT_DAILY_CAP          = 12  // membre : plafond de 50 000 par 24 h atteint
const REJECT_ALREADY_DONE       = 13  // membre : bonus ou mission déjà reçu
const REJECT_NO_PAYMENT         = 14  // membre : mission sans aucun paiement attesté
const REJECT_STALE_VOUCHER      = 15  // membre : numéro de bon déjà utilisé ou trop ancien
const REJECT_NOT_ENOUGH_POINTS  = 16  // membre : conversion au-delà des Points encore valides, ou investissement au-delà des Points attestés

// ---------- Emplacements du budget de paiement (bits) ----------
const SLOT_PRESALE        = 1          // bit 0
const SLOT_PURCHASE       = 2          // bit 1
const SLOT_FIRST_PURCHASE = 4          // bit 2
const SLOT_CHIKA_BONUS    = 256        // bit 8
const SLOT_EARLY          = 512        // bit 9 : contribution du lancement anticipé (une fois par contribution)
// parrainage niveau L : bit (2 + L), soit 8, 16, 32, 64, 128

// TON conservé par chaque budget de paiement et compte membre pour payer ses frais de stockage
// (versé une seule fois, à la création du contrat, par le membre qui envoie le bon)
const CHILD_STORAGE_RESERVE = ton("0.01")

// ---------- Banque d'échange (section 9) ----------
const BANK_CLOSED_PERIOD    = ONE_YEAR    // aucun dépôt ni retrait des membres pendant 12 mois
const BANK_WITHDRAW_DELAY   = ONE_DAY     // retrait possible 24 h après le dernier dépôt
const BANK_DAILY_BURN_BP    = 500         // 5 % du stock par période de 24 h (conversions via la banque)
const BANK_OP_MIN_VALUE     = ton("0.05") // TON minimum joint à une opération qui doit renvoyer des jetons
const BANK_JETTON_FWD_VALUE = ton("0.05") // TON joint à un transfert ou un brûlage depuis le wallet de la banque

// Modes d'une conversion (BurnOrder.mode)
const BURN_FROM_STOCK  = 1   // via la banque
const BURN_FROM_ESCROW = 2   // avec ses propres ConsoM, déjà reçus par la banque

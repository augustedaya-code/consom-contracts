// Constantes de l'émetteur ConsoM. Chaque valeur renvoie à la spécification (docs/SPECIFICATION.md).
// Tous les montants sont en unités de base : 1 ConsoM = 10^9 unités (9 décimales, standard Jetton).

const ONE_CONSOM = 1000000000

// ---------- Section 3 : plafonds par catégorie (gravés au déploiement) ----------
const CAP_PRESALE  = 100000000 * ONE_CONSOM
const CAP_PURCHASE = 55000000 * ONE_CONSOM
const CAP_REFERRAL = 45000000 * ONE_CONSOM
const CAP_MISSIONS = 20000000 * ONE_CONSOM
const CAP_FOUNDERS = 5000000 * ONE_CONSOM     // Anciens Contributeurs
const CAP_TEAM     = 5000000 * ONE_CONSOM
const MAX_SUPPLY   = 230000000 * ONE_CONSOM

// Part des Anciens Contributeurs déposée dans la banque à la genèse : 70 % de 5 M
const FOUNDERS_BANK_DEPOSIT = 3500000 * ONE_CONSOM

// Catégories (index dans Caps)
const CAT_PRESALE  = 0
const CAT_PURCHASE = 1
const CAT_REFERRAL = 2
const CAT_MISSIONS = 3
const CAT_FOUNDERS = 4
const CAT_TEAM     = 5

// ---------- Section 5 : types de bon ----------
const KIND_PRESALE         = 0   // pack de prévente                  -> budget de paiement
const KIND_PURCHASE_RECORD = 1   // enregistre les Points d'un achat   -> budget de paiement (montant 0)
const KIND_REFERRAL        = 2   // parrainage niveau 1 à 5            -> budget de paiement
const KIND_FIRST_PURCHASE  = 3   // bonus de 1er achat                 -> budget de paiement
const KIND_CONVERSION      = 4   // 35 % des Points convertis          -> compte membre
const KIND_MISSION_TG      = 5   // mission Telegram                   -> compte membre
const KIND_MISSION_FB      = 6   // mission Facebook                   -> compte membre
const KIND_INVESTMENT      = 7   // 30 % des FECA investis             -> compte membre
const KIND_BANK_CONVERSION = 8   // conversion via la banque : la banque brûle sur son stock (aucune création)
const KIND_OWN_CONVERSION  = 9   // conversion avec ses propres ConsoM : arrive par la banque, jamais par ClaimVoucher
const KIND_MAX             = 9

// ---------- Section 6 : montants des récompenses ----------
const FIRST_PURCHASE_REWARD = 500 * ONE_CONSOM
const MISSION_REWARD        = 150 * ONE_CONSOM
const CONVERSION_RATE_BP    = 3500   // 35 %
const INVESTMENT_RATE_BP    = 3000   // 30 %
const REFERRAL_L1_BP        = 1500   // 15 %
const REFERRAL_L2_BP        = 700    // 7 %
const REFERRAL_L3_BP        = 350    // 3,5 %
const REFERRAL_L4_BP        = 150    // 1,5 %
const REFERRAL_L5_BP        = 50     // 0,5 %
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
const PRESALE_WINDOW = ONE_YEAR          // la prévente se ferme à T0 + 12 mois
const REWARDS_WINDOW = 18 * ONE_MONTH    // les récompenses s'arrêtent à T0 + 18 mois
const VOUCHER_MAX_VALIDITY = 7 * ONE_DAY

// ---------- Section 10 : sécurité ----------
const GLOBAL_DAILY_CAP        = 2000000 * ONE_CONSOM   // émission maximale par 24 h, prévente comprise
const PAUSE_MAX_DURATION      = 14 * ONE_DAY
const PAUSE_MIN_INTERVAL      = ONE_MONTH              // une seule pause commencée par 30 jours
const WITNESS_TIMELOCK        = 7 * ONE_DAY
const WITNESS_REPLACE_INTERVAL = ONE_MONTH             // un remplacement de témoin par 30 jours
const WITNESS_COUNT           = 3

// ---------- Section 8 : halving ----------
const HALVING_STEP_YEAR1 = 800000 * ONE_CONSOM
const HALVING_STEP_AFTER = 12000000 * ONE_CONSOM
const HALVING_MAX_STEPS  = 30
// brûlage (unités de base) pour P Points avec n paliers = ceil(P × 10^8 / 2^n)  (V = 100 au départ)
const BURN_PER_POINT_NUMERATOR = 100000000

// ---------- Frais (TON) ----------
const MIN_CLAIM_VALUE     = ton("0.25")   // un bon traverse 3 contrats avant la création des jetons
const MINT_TON_VALUE      = ton("0.05")   // TON joint à une création de jetons (le reste revient au membre)
const RECYCLE_MIN_VALUE   = ton("0.1")    // TON minimum joint à un brûlage volontaire pour financer sa recréation
const BANK_NOTIFY_VALUE   = ton("0.02")   // TON transmis à la banque avec un dépôt (notification)
const MIN_STORAGE_RESERVE = ton("0.05")

// ---------- Compte membre (section 6) ----------
const MEMBER_DAILY_CAP   = 50000 * ONE_CONSOM   // reçu par membre et par 24 h, hors prévente
const POINTS_VALIDITY    = 7 * ONE_DAY          // les Points d'un achat se convertissent dans les 7 jours, sinon ils sont perdus
const POINTS_BUCKET      = 3600                 // Points regroupés par heure d'expiration (arrondie vers le bas : jamais plus de 7 jours)

// ---------- Raisons de refus (ClaimRejected.reason) ----------
const REJECT_SLOT_USED          = 1   // budget : cette récompense a déjà été versée pour ce paiement
const REJECT_PAYMENT_MISMATCH   = 2   // budget : montant ou Points différents de ceux déjà attestés pour ce paiement
const REJECT_PRESALE_EXCLUSIVE  = 3   // budget : un paiement de prévente ne donne pas d'autre récompense (et inversement)
const REJECT_WRONG_OWNER        = 10  // membre : le bon n'est pas pour l'adresse liée au compte
const REJECT_NOT_ELIGIBLE       = 11  // membre : parrain sans prévente ni statut d'Ancien Contributeur
const REJECT_DAILY_CAP          = 12  // membre : plafond de 50 000 par 24 h atteint
const REJECT_ALREADY_DONE       = 13  // membre : bonus ou mission déjà reçu
const REJECT_NO_PAYMENT         = 14  // membre : mission sans aucun paiement attesté
const REJECT_STALE_VOUCHER      = 15  // membre : numéro de bon déjà utilisé ou trop ancien
const REJECT_NOT_ENOUGH_POINTS  = 16  // membre : conversion au-delà des Points encore valides, ou investissement au-delà des Points attestés

// ---------- Emplacements du budget de paiement (bits) ----------
const SLOT_PRESALE        = 1          // bit 0
const SLOT_PURCHASE       = 2          // bit 1
const SLOT_FIRST_PURCHASE = 4          // bit 2
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

# Wallet Jetton : origine

Les fichiers de ce dossier sont repris **sans modification** de la version Tolk du Jetton « shardé »
publiée par l'équipe TON dans le dépôt [ton-blockchain/tolk-bench](https://github.com/ton-blockchain/tolk-bench)
(`contracts_Tolk/04_sharded_tgbtc`, commit `57e1009743bfc19748caa95d76180d9e9793e4c5`), sous licence MIT (voir `LICENSE`).

Ce wallet suit le standard TEP-74 et place chaque wallet Jetton dans le même shard que le wallet de son propriétaire,
le principe de Jetton 2.0. Le fichier `JettonMinter.tolk` d'origine n'est pas repris : l'émetteur de ConsoM est
`contracts/consom/minter.tolk`.

Avant l'audit, vérifier que ces fichiers sont toujours identiques à la version de référence choisie, et ne jamais les
modifier ici : toute logique propre à ConsoM vit dans l'émetteur et ses contrats enfants.

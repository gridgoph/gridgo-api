# Operational Model v2 Migration Checksum Report

Verified 2026-08-10 against a private copy of `/home/kali/firstmate/projects/gridgo-api/data/store.json`. The source was read and copied only; it was never started or modified. The copy contained 7 orders and 9 file records at verification time.

- Source/copy SHA-256 before load: `8dee6586a547db6275b7f0d39b0bb0afe24dfe86a83d39e92044c1d77eda9bab`
- Copy SHA-256 after v2 load: `d28d7846ee1391225a93787c24480a5ccddf4a9e95da6c0770f214f4c751e3a9`
- Test API: loopback port `47873`, selected only after confirming it was free.
- Each run used its captured PID and was stopped with `SIGTERM` to that exact PID.
- Result: the second load produced identical hashes for every top-level collection/value.

Hashes are SHA-256 over `JSON.stringify(store[key])` for each top-level key.

| Key | Before | After first load | After second load | Result |
|---|---|---|---|---|
| `auditLog` | `8d18ae2da3e66f3f753b0d19d05068068841504efd56efc6d03435ad2a45cf53` | same | same | unchanged |
| `catalog` | `3bf383c42dcb9dfc8e98aa2540ecd4d9e98ba573842f63abaabdeb0afcf57fac` | same | same | unchanged |
| `claims` | `70ddaaa26fa9bb95862efebd602fefcde7e0cc9259d3abfa434a9fb387f5a25d` | same | same | unchanged |
| `credits` | `ef3b1dd9331d214659120c046523ce11466548d6093d3bea188267f134ea2371` | same | same | unchanged |
| `escalations` | absent | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` | same | added empty collection |
| `files` | `4c962fceb19ae1a75cc279b76f843fcfa27763904a7919971125596ff3d0f802` | same | same | unchanged; all file metadata preserved |
| `issues` | `17f4e5000c3999833dcfe95c8ac6634216ad991cfddd7141c329d23fcaf31e6d` | same | same | unchanged |
| `locationPings` | `64794029f3728d68f8b356ffa3e435f7107b6c3a6292bb011bc6c3c462efa6d8` | same | same | unchanged |
| `notifications` | `14284a80b0bc1512131827e59f9ff1f3864e91a8d050352db6becfc3ec1e1284` | `a7649cf4f05ede365b14327a50227d3415716527161ae95dbc4bfc705c3a8251` | same | changed once: assignment notifications added where required |
| `orders` | `ab1ed2e473b95f545036023dd2887e29d1d74ec555aa253881854b33e89319e8` | `a2d1bd15b240df9169ef66932299fd30b89e3ebedd7608a5b1577ba4dd048e25` | same | changed once: v2 fields/state/payment normalization |
| `proofs` | `1d528e412c8e079e0206f8b8def79b4de3d637a331131da1d2538f5404fd55c6` | same | same | unchanged legacy evidence |
| `sessions` | `37b4451cf5e412f7471aeaf059b4e0d0fc8c4c95813aa15a2e43b39d5e05eded` | same | same | unchanged |
| `settings` | absent | `bd99127a8e1ded840b9e4fddb24a7be1cefbed9a92bed51e9ed0c2937c9ca544` | same | added provisional bands + global issue hours |
| `supplierServices` | `b2757471668d938eaa8c57ab02f41b307d4d08740cea72531e85b061d4795e2b` | same | same | unchanged |
| `taxonomy` | `75ef1307fb5760f7a87b8ea3baaf48dab40afe780dc6c76164eec37191ad54ee` | same | same | unchanged |
| `users` | `7fdf124acadabbcd783eb4f949a050d6201b4b589efde38a50dd18a95994ffe0` | same | same | unchanged |
| `version` | `6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b` | same | same | unchanged |
| `zones` | `bd48ef490eae684bbcbde9816e1219508be5d67b5922b94abd95986321b791df` | same | same | unchanged |

The second-run equality includes dynamically sensitive values: no duplicate notification, timeline entry, milestone, or timestamp was created.

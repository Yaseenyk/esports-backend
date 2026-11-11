// Old-code goldens against the new schema (exit criterion 2): the Worker in this repo (the "old" code: no org logic, flags absent) runs the committed
// golden suite on a database that went 0001 to 0034, received a legacy world, then 0035 and later. Output must equal the committed golden files.
import { applyUpTo, applyAll, seedLegacyWorld } from "./world";

await applyUpTo(35);
await seedLegacyWorld();
await applyAll();
await import("../golden/gen.test");

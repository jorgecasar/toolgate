// Preload for a child process of a test (`node --import fs-guard-preload.js`): installs the read guard of the real home with the folders
// (`TG_HERMETIC_FS_REFUSED`, a JSON list) and the violations log (`TG_HERMETIC_FS_LOG`) the parent test process put in the environment.
// Without them it does nothing. It is not imported by `hermetic.js`, which works the folders out itself.
import { installFsGuard } from "./fs-guard.js";

if (process.env.TG_HERMETIC_FS_REFUSED && process.env.TG_HERMETIC_FS_LOG) {
  let folders = [];
  try {
    folders = JSON.parse(process.env.TG_HERMETIC_FS_REFUSED);
  } catch {
    // Not a list: no guard, as without the variable.
  }
  if (Array.isArray(folders)) installFsGuard({ folders: folders.filter((folder) => typeof folder === "string"), log: process.env.TG_HERMETIC_FS_LOG, record: process.env.TG_HERMETIC_FS === "record" });
}

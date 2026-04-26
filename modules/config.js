import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.js";

export const HOME = os.homedir();
export const ROOT_CONFIG_FILE = path.join(HOME, ".osiris", "config.json");
export const PROJECT_CONFIG_NAME = ".osiris.json";

export function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function isUnderHome(dir) {
  const rel = path.relative(HOME, dir);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function loadConfig() {
  // Root / global config
  logger.step("config", `checking root config: ${ROOT_CONFIG_FILE}`);
  const rootCfg = readJsonFile(ROOT_CONFIG_FILE) ?? {};
  if (Object.keys(rootCfg).length) {
    logger.ok("config", "root config loaded");
    logger.json("config:root", rootCfg);
  } else {
    logger.warn("config", "root config not found or empty — using defaults");
  }

  const searchDepth = Number.isInteger(rootCfg.searchDepth) ? rootCfg.searchDepth : 3;
  logger.step("config", `searchDepth = ${searchDepth}`);

  const cwd = process.cwd();
  const layeredCfgs = [];

  if (isUnderHome(cwd)) {
    logger.step("config", `cwd is within ~ — searching ${searchDepth} level(s) up`);
    let dir = cwd;
    for (let i = 0; i < searchDepth; i++) {
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
      if (!isUnderHome(dir)) {
        logger.warn("config", `stopped at ${dir} — outside ~`);
        break;
      }
      const cfgPath = path.join(dir, PROJECT_CONFIG_NAME);
      const cfg = readJsonFile(cfgPath);
      if (cfg) {
        logger.ok("config", `ancestor config found: ${cfgPath}`);
        logger.json("config:ancestor", cfg);
        layeredCfgs.unshift(cfg); // farther configs first → lower priority
      } else {
        logger.step("config", `no config at: ${cfgPath}`);
      }
    }
  } else {
    logger.warn("config", `cwd ${cwd} is outside ~ — skipping ancestor search`);
  }

  // Current directory config
  const cwdCfgPath = path.join(cwd, PROJECT_CONFIG_NAME);
  logger.step("config", `checking cwd config: ${cwdCfgPath}`);
  const cwdCfg = readJsonFile(cwdCfgPath) ?? {};
  if (Object.keys(cwdCfg).length) {
    logger.ok("config", "cwd config loaded");
    logger.json("config:cwd", cwdCfg);
  } else {
    logger.step("config", "no cwd config found");
  }

  const { searchDepth: _sd, ...rootCfgClean } = rootCfg;
  const merged = Object.assign({}, rootCfgClean, ...layeredCfgs, cwdCfg);

  if (logger.active()) logger.json("config:merged", merged);

  return merged;
}

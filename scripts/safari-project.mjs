#!/usr/bin/env node
/**
 * Bootstraps or syncs the universal macOS + iOS Safari Web Extension Xcode project.
 *
 * - First run (no Xcode project yet): converts `dist/safari` into `safari/` and sets
 *   Safari 16.4+ deployment targets and `MARKETING_VERSION` from the manifest.
 * - Subsequent runs: never overwrites `project.pbxproj` (preserving signing team,
 *   `CURRENT_PROJECT_VERSION`, icons, and Xcode edits); only refreshes extension
 *   resources and syncs `MARKETING_VERSION`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST_SAFARI = "dist/safari";
const SAFARI_DIR = "safari";
const APP_NAME = "RyanQuack";
const BUNDLE_ID = "com.ryanquack.RyanQuack";
const PROJECT_DIR = join(SAFARI_DIR, APP_NAME);
const PBXPROJ = join(PROJECT_DIR, `${APP_NAME}.xcodeproj`, "project.pbxproj");
const RESOURCES_DIR = join(PROJECT_DIR, "Shared (Extension)", "Resources");

const IOS_MIN_VERSION = "16.4";
const MACOS_MIN_VERSION = "13.3";

const manifest = JSON.parse(readFileSync(join(DIST_SAFARI, "manifest.json"), "utf8"));
const version = String(manifest.version);

function patchPbxproj(file, { setDeploymentTargets }) {
  let content = readFileSync(file, "utf8");
  content = content.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
  if (setDeploymentTargets) {
    content = content.replace(/IPHONEOS_DEPLOYMENT_TARGET = [^;]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_MIN_VERSION};`);
    content = content.replace(/MACOSX_DEPLOYMENT_TARGET = [^;]+;/g, `MACOSX_DEPLOYMENT_TARGET = ${MACOS_MIN_VERSION};`);
  }
  writeFileSync(file, content);
}

if (!existsSync(PBXPROJ)) {
  execFileSync(
    "xcrun",
    [
      "safari-web-extension-converter",
      DIST_SAFARI,
      "--project-location",
      SAFARI_DIR,
      "--app-name",
      APP_NAME,
      "--bundle-identifier",
      BUNDLE_ID,
      "--swift",
      "--copy-resources",
      "--no-open",
      "--no-prompt",
    ],
    { stdio: "inherit" },
  );
  patchPbxproj(PBXPROJ, { setDeploymentTargets: true });
} else {
  rmSync(RESOURCES_DIR, { recursive: true, force: true });
  cpSync(DIST_SAFARI, RESOURCES_DIR, { recursive: true });
  patchPbxproj(PBXPROJ, { setDeploymentTargets: false });
  console.log(`Synced ${DIST_SAFARI} -> ${RESOURCES_DIR} (MARKETING_VERSION = ${version})`);
}

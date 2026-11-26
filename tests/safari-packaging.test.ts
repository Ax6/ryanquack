import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const manifest = (target: string) => JSON.parse(readFileSync(`dist/${target}/manifest.json`, "utf8"));
const chrome = manifest("chrome");
const firefox = manifest("firefox");
const safari = manifest("safari");

function expectAtLeast(version: string, minimum: string) {
  expect(version, `expected a version >= ${minimum}`).toMatch(/^\d+(\.\d+)*$/);
  const [major, minor = 0] = version.split(".").map(Number);
  const [minMajor, minMinor] = minimum.split(".").map(Number);
  expect(major > minMajor || (major === minMajor && minor >= minMinor),
    `expected ${version} >= ${minimum}`).toBe(true);
}

it("ships Chrome and Firefox with downloads and matching versions", () => {
  expect(chrome.permissions).toContain("downloads");
  expect(firefox.permissions).toContain("downloads");
  expect(firefox.version).toBe(chrome.version);
});

it("ships Safari with Chrome's version, hosts, content scripts and action, without downloads", () => {
  expect(safari.permissions).not.toContain("downloads");
  for (const key of ["version", "host_permissions", "content_scripts", "action"]) {
    expect(safari[key]).toEqual(chrome[key]);
  }
});

it("declares Safari 16.4 or later", () => {
  const minimum = safari.browser_specific_settings?.safari?.strict_min_version;
  expect(minimum, "missing browser_specific_settings.safari.strict_min_version").toBeDefined();
  expectAtLeast(minimum, "16.4");
});

it("uses a classic non-persistent background script with no unsupported Safari manifest keys", () => {
  expect(safari.background).toEqual({ scripts: ["background.js"], persistent: false });
  expect(safari.description.length).toBeLessThanOrEqual(112);
  expect(existsSync("dist/safari/background.js")).toBe(true);
  expect(existsSync("dist/safari/service-worker-loader.js")).toBe(false);
  for (const entry of safari.web_accessible_resources ?? []) {
    expect(entry).not.toHaveProperty("use_dynamic_url");
  }
});

it("has no duplicate Safari source manifest", () => {
  expect(existsSync("src/manifests/manifest.safari.json")).toBe(false);
});

describe("Xcode app and extension", () => {
  const project = "safari/RyanQuack/RyanQuack.xcodeproj/project.pbxproj";
  let scratch: string;
  let settings: { productType: string; build: Record<string, string> }[];
  const run = (script: string) => execFileSync("npm", ["run", script], { cwd: scratch });

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "ryanquack-packaging-"));
    for (const path of ["src", "public", "scripts", "dist/safari", "vite.config.ts", "tsconfig.json", "package.json"]) {
      cpSync(path, join(scratch, path), { recursive: true });
    }
    symlinkSync(resolve("node_modules"), join(scratch, "node_modules"), "dir");
    // The generated project is gitignored. Bootstrap it only in scratch on a clean checkout.
    if (existsSync(project)) cpSync("safari", join(scratch, "safari"), { recursive: true });
    else run("safari:convert");

    const { objects } = JSON.parse(execFileSync("plutil",
      ["-convert", "json", "-o", "-", join(scratch, project)], { encoding: "utf8" }));
    type Target = { isa: string; productType: string; buildConfigurationList: string };
    settings = (Object.values(objects) as Target[]).filter(t => t.isa === "PBXNativeTarget")
      .flatMap(t => objects[t.buildConfigurationList].buildConfigurations.map((id: string) => ({
        productType: t.productType, build: objects[id].buildSettings,
      })));
  });

  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

  it("uses the RyanQuack bundle IDs for the app and extension", () => {
    for (const [type, id] of [
      ["application", "com.ryanquack.RyanQuack"],
      ["app-extension", "com.ryanquack.RyanQuack.Extension"],
    ]) {
      const targets = settings.filter(s => s.productType === `com.apple.product-type.${type}`);
      expect(targets.length).toBeGreaterThan(0);
      for (const { build } of targets) expect(build.PRODUCT_BUNDLE_IDENTIFIER).toBe(id);
    }
  });

  it.each([
    ["iphoneos", "IPHONEOS_DEPLOYMENT_TARGET", "16.4"],
    ["macosx", "MACOSX_DEPLOYMENT_TARGET", "13.3"],
  ])("sets the %s deployment minimum", (sdk, key, minimum) => {
    const configs = settings.filter(s => s.build.SDKROOT === sdk);
    expect(configs.length).toBeGreaterThan(0);
    for (const { build } of configs) expectAtLeast(build[key], minimum);
  });

  it("matches the manifest marketing version in every configuration", () => {
    expect(new Set(settings.map(s => s.build.MARKETING_VERSION))).toEqual(new Set([chrome.version]));
  });

  it("preserves a custom build number when rebuilding the Safari project", () => {
    const file = join(scratch, project);
    const numbers = /CURRENT_PROJECT_VERSION = (\d+);/g;
    const original = readFileSync(file, "utf8");
    expect(original).toMatch(numbers);
    writeFileSync(file, original.replace(numbers, "CURRENT_PROJECT_VERSION = 77;"));

    const { scripts } = JSON.parse(readFileSync(join(scratch, "package.json"), "utf8"));
    run(scripts["safari:sync"] ? "safari:sync" : "safari:convert");
    const after = Array.from(readFileSync(file, "utf8").matchAll(numbers), m => m[1]);
    expect(after).toEqual(Array.from(original.matchAll(numbers), () => "77"));
  });

  it("fails safari:sync if a new top-level file in dist/safari is not tracked in project.pbxproj", () => {
    const extraFile = join(scratch, "dist/safari/extra-untracked.js");
    writeFileSync(extraFile, "// drift\n");
    try {
      expect(() =>
        execFileSync("node", ["scripts/safari-project.mjs"], { cwd: scratch, stdio: "pipe" }),
      ).toThrow(/resource drift detected.*extra-untracked\.js/i);
    } finally {
      rmSync(extraFile, { force: true });
    }
  });
});

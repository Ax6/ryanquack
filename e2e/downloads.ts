import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";

const alex = "aaanb3_stn-krk_fr1000_alex_smith_10a";
const sam = "aaav3j_dub-alc_fr1013_sam_murphy_10a";
export const firstPng = `${alex}.png`;
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

export function expectPng(file: string) {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8)).toEqual(pngSignature);
  expect(bytes.subarray(-8, -4).toString()).toBe("IEND");
}

export function expectPkpass(file: string) {
  expect(readFileSync(file, "utf8")).toBe("DUMMY_PKPASS_DATA");
}

export function expectPassZip(file: string) {
  expect(readFileSync(file).subarray(0, 4)).toEqual(Buffer.from("504b0304", "hex"));
  // Verify the central directory and every entry's CRC with an independent ZIP reader.
  execFileSync("unzip", ["-t", file]);
  const entries = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
  expect(entries.sort()).toEqual([alex, sam].flatMap(name => [`${name}.pkpass`, `${name}.png`]).sort());
  for (const name of [alex, sam]) {
    expect(execFileSync("unzip", ["-p", file, `${name}.png`]).subarray(0, 8)).toEqual(pngSignature);
    expect(execFileSync("unzip", ["-p", file, `${name}.pkpass`]).toString()).toBe("DUMMY_PKPASS_DATA");
  }
}

import { describe, it, expect } from "vitest";
import { errorText, errorStatus } from "./errors";

describe("errorText", () => {
  it("uses the message when there is one", () => {
    expect(errorText(new Error("downloadpass failed: 422"))).toBe("downloadpass failed: 422");
  });

  it("falls back when the message is empty or blank", () => {
    expect(errorText(new Error(""))).toBe("Error");
    expect(errorText({ message: "   " })).toBe("Unknown error");
  });

  it("handles thrown non-errors", () => {
    expect(errorText("plain string")).toBe("plain string");
    expect(errorText(null)).toBe("null");
    expect(errorText({})).toBe("Unknown error");
  });
});

describe("errorStatus", () => {
  it("reads a numeric status off the error", () => {
    expect(errorStatus(Object.assign(new Error("x"), { status: 422 }))).toBe(422);
  });

  it("returns null when there is no usable status", () => {
    expect(errorStatus(new Error("x"))).toBe(null);
    expect(errorStatus({ status: "422" })).toBe(null);
    expect(errorStatus(null)).toBe(null);
  });
});

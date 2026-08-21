import { describe, expect, it } from "vitest";
import { formatMatchDate, formatMatchDateParts } from "./format";

// Use a January date so UK and UTC clocks agree (no BST offset to worry about).
// 2026-01-15T13:45:00.000Z → Thu 15 Jan 13:45 in en-GB/UTC.
const VALID_ISO = "2026-01-15T13:45:00.000Z";

describe("formatMatchDateParts", () => {
  it("returns non-empty date and time parts for a valid ISO string", () => {
    const { date, time } = formatMatchDateParts(VALID_ISO);
    expect(date).toBeTruthy();
    expect(time).toBeTruthy();
  });

  it("renders time in HH:MM 24-hour format", () => {
    const { time } = formatMatchDateParts(VALID_ISO);
    expect(time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("includes the day-of-month number in the date part", () => {
    const { date } = formatMatchDateParts(VALID_ISO);
    expect(date).toContain("15");
  });

  it("includes a short month name in the date part", () => {
    const { date } = formatMatchDateParts(VALID_ISO);
    expect(date).toMatch(/Jan/i);
  });

  it("returns empty strings for a non-date string", () => {
    expect(formatMatchDateParts("not a date")).toEqual({ date: "", time: "" });
  });

  it("returns empty strings for an empty string", () => {
    expect(formatMatchDateParts("")).toEqual({ date: "", time: "" });
  });

  it("returns empty strings for a partial date string", () => {
    expect(formatMatchDateParts("2026-13-99")).toEqual({ date: "", time: "" });
  });
});

describe("formatMatchDate", () => {
  it("joins date and time with a space for a valid ISO string", () => {
    const result = formatMatchDate(VALID_ISO);
    const { date, time } = formatMatchDateParts(VALID_ISO);
    expect(result).toBe(`${date} ${time}`);
  });

  it("returns the empty string for an invalid input", () => {
    expect(formatMatchDate("not a date")).toBe("");
  });

  it("returns the empty string for an empty string", () => {
    expect(formatMatchDate("")).toBe("");
  });
});

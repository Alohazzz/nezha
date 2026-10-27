import { describe, expect, it } from "vitest";
import {
  composerCanSend,
  extractImageFiles,
  makeImageId,
  MAX_IMAGE_DATA_URL_LENGTH,
} from "../components/codex-stream/composerImages";

/** DataTransferItem 在 jsdom 不可构造，用最小 duck-type 桩。 */
function fakeItem(kind: string, type: string, file?: File): DataTransferItem {
  return {
    kind,
    type,
    getAsFile: () => file ?? null,
    getAsString: () => undefined,
    webkitGetAsEntry: () => null,
  } as unknown as DataTransferItem;
}

describe("extractImageFiles", () => {
  it("keeps only image file items in order", () => {
    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.jpeg", { type: "image/jpeg" });
    const items = [
      fakeItem("string", "text/plain"),
      fakeItem("file", "image/png", a),
      fakeItem("string", "text/html"),
      fakeItem("file", "image/jpeg", b),
      fakeItem("file", "application/json"),
    ];
    const files = extractImageFiles(items);
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe("a.png");
    expect(files[1].name).toBe("b.jpeg");
  });

  it("ignores file items whose getAsFile returns null", () => {
    const items = [fakeItem("file", "image/png")];
    expect(extractImageFiles(items)).toHaveLength(0);
  });

  it("returns empty for no items", () => {
    expect(extractImageFiles([])).toHaveLength(0);
  });
});

describe("makeImageId", () => {
  it("produces unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeImageId()));
    expect(ids.size).toBe(50);
  });
});

describe("MAX_IMAGE_DATA_URL_LENGTH", () => {
  it("is 20MB of characters", () => {
    expect(MAX_IMAGE_DATA_URL_LENGTH).toBe(20 * 1024 * 1024);
  });
});

describe("composerCanSend", () => {
  it("allows text-only send", () => {
    expect(composerCanSend({ text: "fix this", imageCount: 0 })).toBe(true);
  });

  it("allows image-only send (empty/whitespace text)", () => {
    expect(composerCanSend({ text: "", imageCount: 1 })).toBe(true);
    expect(composerCanSend({ text: "   ", imageCount: 2 })).toBe(true);
  });

  it("blocks empty composer", () => {
    expect(composerCanSend({ text: "", imageCount: 0 })).toBe(false);
    expect(composerCanSend({ text: "   ", imageCount: 0 })).toBe(false);
  });

  it("disabled and busy veto everything", () => {
    expect(composerCanSend({ disabled: true, text: "hi", imageCount: 1 })).toBe(false);
    expect(composerCanSend({ busy: true, text: "hi", imageCount: 1 })).toBe(false);
    expect(composerCanSend({ disabled: true, busy: true, text: "", imageCount: 0 })).toBe(false);
  });
});

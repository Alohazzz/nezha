import { describe, expect, it } from "vitest";
import { columnForStatus } from "../components/KanbanView";
import type { TaskStatus } from "../types";

describe("columnForStatus", () => {
  it("待办任务归入 todo 列", () => {
    expect(columnForStatus("todo")).toBe("todo");
  });

  it("pending/running 归入 running 列", () => {
    expect(columnForStatus("pending")).toBe("running");
    expect(columnForStatus("running")).toBe("running");
  });

  it("需要介入的状态归入 attention 列", () => {
    expect(columnForStatus("input_required")).toBe("attention");
    expect(columnForStatus("detached")).toBe("attention");
    expect(columnForStatus("interrupted")).toBe("attention");
  });

  it("awaiting_review 归入 awaiting 列", () => {
    expect(columnForStatus("awaiting_review")).toBe("awaiting");
  });

  it("终态任务不进入看板", () => {
    const terminal: TaskStatus[] = ["done", "failed", "cancelled"];
    terminal.forEach((status) => expect(columnForStatus(status)).toBeNull());
  });
});
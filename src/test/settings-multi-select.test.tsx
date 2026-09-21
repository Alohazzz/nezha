import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MultiSelect } from "../components/settings/MultiSelect";
import { I18nProvider } from "../i18n";

const options = [
  { value: "DrugInOut", label: "DrugInOut" },
  { value: "Term", label: "Term" },
  { value: "Hsp.Win", label: "Hsp.Win" },
];

function renderSelect(props: Partial<React.ComponentProps<typeof MultiSelect>> = {}) {
  const onChange = vi.fn();
  render(
    <I18nProvider>
      <MultiSelect
        options={options}
        selected={[]}
        onChange={onChange}
        allOption="全部子仓库（不限制）"
        emptyLabel="本项目未发现子仓库。"
        {...props}
      />
    </I18nProvider>,
  );
  return { onChange };
}

describe("MultiSelect", () => {
  it("shows the sentinel 'all' state when nothing is selected", async () => {
    renderSelect();
    expect(await screen.findByText("全部子仓库（不限制）")).toBeInTheDocument();
  });

  it("toggles a concrete option on when picked", async () => {
    const { onChange } = renderSelect();
    fireEvent.click(screen.getByRole("button", { name: "全部子仓库（不限制）" }));
    fireEvent.click(await screen.findByText("Hsp.Win"));
    expect(onChange).toHaveBeenCalledWith(["Hsp.Win"]);
  });

  it("drops an option that is already selected", async () => {
    const { onChange } = renderSelect({ selected: ["Term", "Hsp.Win"] });
    fireEvent.click(screen.getByRole("button", { name: "全部子仓库（不限制）" }));
    fireEvent.click(await screen.findByText("Term"));
    expect(onChange).toHaveBeenCalledWith(["Hsp.Win"]);
  });

  it("returns to the unrestricted state via the sentinel row", async () => {
    const { onChange } = renderSelect({ selected: ["Hsp.Win"] });
    fireEvent.click(screen.getByRole("button", { name: "全部子仓库（不限制）" }));
    // 弹层里「全部」作为标题 + 哨兵项各出现一次，点击哨兵项所在的 label
    const rows = await screen.findAllByText("全部子仓库（不限制）");
    fireEvent.click(rows[rows.length - 1]);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("summarizes selected labels on the trigger", () => {
    renderSelect({ selected: ["Term", "Hsp.Win"] });
    expect(screen.getByRole("button", { name: "全部子仓库（不限制）" })).toHaveTextContent(
      "Term, Hsp.Win",
    );
  });

  it("keeps a saved value that is no longer among the discovered options", () => {
    renderSelect({ selected: ["Renamed.Repo"] });
    expect(screen.getByRole("button", { name: "全部子仓库（不限制）" })).toHaveTextContent(
      "Renamed.Repo",
    );
  });

  it("falls back to the empty hint when there are no options and no sentinel", async () => {
    render(
      <I18nProvider>
        <MultiSelect
          options={[]}
          selected={[]}
          onChange={() => {}}
          placeholder="选择子仓库"
          emptyLabel="本项目未发现子仓库。"
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择子仓库" }));
    expect(await screen.findByText("本项目未发现子仓库。")).toBeInTheDocument();
  });

  it("emits an empty selection when clearing with no sentinel", async () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <MultiSelect
          options={options}
          selected={["Term"]}
          onChange={onChange}
          placeholder="选择子仓库"
          emptyLabel="无"
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择子仓库" }));
    // jsdom 的 navigator.language 为 en，i18n 回退英文文案
    fireEvent.click(await screen.findByText("Clear"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

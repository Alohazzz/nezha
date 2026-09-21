import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Loader2, Plus, Search, UserRound, X } from "lucide-react";

/** 云效组织成员（`codeup_list_members` 返回项）。 */
export interface CodeupMember {
  name: string;
  userId: string;
}

/**
 * 评审人选择器（对齐云效「新建合并请求 → 添加成员」的交互）。
 *
 * 云效的评审人字段收的是**用户 ID**，而用户输入/保护规则预填给出的都是**人名**，
 * 因此这里始终以「人名」作为选中值的表示，由后端在发起时统一解析成 userID
 * （重名 / 查无此人会显式报错，不会静默丢掉评审人）。
 *
 * 不做前端缓存：成员表由后端按组织缓存（带 TTL），这里每次挂载都读一次既便宜，
 * 又能让新入职/改名的成员及时出现。
 *
 * 交互：输入框聚焦即展开成员列表，可搜索、可勾选（推荐成员排在最前）；
 * 输入的内容回车可直接加为自由文本，保证成员表拉取失败时仍能提交。
 */
export function ReviewerPicker({
  value,
  onChange,
  recommended = [],
  disabled = false,
  placeholder = "输入姓名搜索，回车可直接添加",
}: {
  /** 已选评审人（人名）。 */
  value: string[];
  onChange: (next: string[]) => void;
  /** 目标分支保护规则里的默认评审人，置顶展示。 */
  recommended?: string[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const [members, setMembers] = useState<CodeupMember[] | null>(null);
  const [membersError, setMembersError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    invoke<CodeupMember[]>("codeup_list_members")
      .then((list) => {
        if (alive) setMembers(list);
      })
      .catch((e) => {
        if (alive) setMembersError(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // 点外部收起列表；用 mousedown 以便在输入框失焦前处理。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = useCallback(
    (name: string) => {
      const next = value.includes(name) ? value.filter((n) => n !== name) : [...value, name];
      onChange(next);
      setQuery("");
    },
    [value, onChange],
  );

  const addFreeText = useCallback(() => {
    const name = query.trim();
    if (!name || value.includes(name)) return;
    onChange([...value, name]);
    setQuery("");
  }, [query, value, onChange]);

  /** 候选列表：推荐成员置顶，其余按姓名排序；空查询时展示全部（上限防长列表卡顿）。 */
  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = members ?? [];
    const matched = q ? all.filter((m) => m.name.toLowerCase().includes(q)) : all;
    const recommendedSet = new Set(recommended);
    const head = recommended
      .filter((name) => (q ? name.toLowerCase().includes(q) : true))
      .map((name) => ({ name, userId: all.find((m) => m.name === name)?.userId ?? "" }));
    const tail = matched
      .filter((m) => !recommendedSet.has(m.name))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    return [...head, ...tail].slice(0, 200);
  }, [members, recommended, query]);

  const exactMatch = (members ?? []).some((m) => m.name === query.trim());

  return (
    <div className="pm-reviewers" ref={rootRef}>
      <div className="pm-reviewers-box" data-disabled={disabled || undefined}>
        {value.map((name) => (
          <span key={name} className="pm-reviewers-chip">
            <UserRound size={10} />
            <span className="pm-reviewers-chip-name">{name}</span>
            <button
              type="button"
              className="pm-reviewers-chip-remove"
              aria-label={`移除评审人 ${name}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((n) => n !== name))}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <span className="pm-reviewers-input-wrap">
          <Search size={11} className="pm-reviewers-input-icon" />
          <input
            className="pm-reviewers-input"
            value={query}
            disabled={disabled}
            placeholder={value.length === 0 ? placeholder : ""}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // 已有完全匹配的成员就直接选中它，否则按自由文本加入。
                const hit = (members ?? []).find((m) => m.name === query.trim());
                if (hit) toggle(hit.name);
                else addFreeText();
              } else if (e.key === "Backspace" && !query && value.length > 0) {
                onChange(value.slice(0, -1));
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
        </span>
      </div>

      {open && (
        <div className="pm-reviewers-menu">
          <div className="pm-reviewers-menu-head">
            <span>
              {query.trim() ? `搜索结果 ${options.length}` : `成员 ${members?.length ?? 0}`}
            </span>
            {value.length > 0 && <span className="pm-reviewers-count">已选 {value.length}</span>}
          </div>

          {membersError && (
            <div className="pm-reviewers-hint" data-tone="warn">
              成员列表加载失败，可手动输入姓名后回车：{membersError}
            </div>
          )}

          {!members && !membersError && (
            <div className="pm-reviewers-hint">
              <Loader2 size={12} className="spin" /> 正在加载组织成员…
            </div>
          )}

          {members && options.length === 0 && (
            <div className="pm-reviewers-hint">
              {query.trim() ? (
                <>
                  没有匹配的成员，回车可把「{query.trim()}」作为评审人提交。
                </>
              ) : (
                "组织成员列表为空。"
              )}
            </div>
          )}

          {options.map((option) => {
            const checked = value.includes(option.name);
            return (
              <button
                key={option.userId || option.name}
                type="button"
                className="pm-reviewers-option"
                data-checked={checked}
                disabled={disabled}
                onClick={() => toggle(option.name)}
              >
                <span className="pm-reviewers-option-check">{checked && <Check size={11} />}</span>
                <span className="pm-reviewers-option-name">{option.name}</span>
                {recommended.includes(option.name) && (
                  <span className="pm-reviewers-option-tag">推荐</span>
                )}
              </button>
            );
          })}

          {/* 输入了成员表里没有的名字时，给一条显式的「添加」入口。 */}
          {members && query.trim() && !exactMatch && (
            <button type="button" className="pm-reviewers-option" onClick={addFreeText}>
              <span className="pm-reviewers-option-check">
                <Plus size={11} />
              </span>
              <span className="pm-reviewers-option-name">添加「{query.trim()}」</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

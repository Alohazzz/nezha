import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import s from "../../styles";

interface DiffFileStat {
  path: string;
  additions: number;
  deletions: number;
}

export function BranchBatchDiff({
  projectPath,
  baseBranch,
  branch,
  onClose,
}: {
  projectPath: string;
  baseBranch: string;
  branch: string;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<DiffFileStat[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [diff, setDiff] = useState<string>("");

  const selectFile = useCallback(
    async (path: string) => {
      setSelected(path);
      try {
        const text = await invoke<string>("git_branch_diff_file", {
          projectPath,
          baseBranch,
          branch,
          filePath: path,
        });
        setDiff(text);
      } catch (e) {
        console.error("[branch-batch] diff file failed:", e);
        setDiff("");
      }
    },
    [projectPath, baseBranch, branch],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await invoke<DiffFileStat[]>("git_branch_diff_stats", {
          projectPath,
          baseBranch,
          branch,
        });
        if (!alive) return;
        setFiles(list);
        if (list.length > 0) {
          await selectFile(list[0].path);
        }
      } catch (e) {
        console.error("[branch-batch] diff stats failed:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectPath, baseBranch, branch, selectFile]);

  const lineStyle = (line: string) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return s.bbDiffLineAdd;
    if (line.startsWith("-") && !line.startsWith("---")) return s.bbDiffLineDel;
    if (line.startsWith("@@")) return s.bbDiffHunk;
    return s.bbDiffLine;
  };

  return (
    <div style={s.bbDiffOverlay}>
      <div style={s.bbDiffDialog}>
        <div style={s.bbDiffHead}>
          <span style={s.bbCardMono}>{branch}</span>
          <span>← {baseBranch}</span>
          <div style={s.bbFill} />
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
            关闭
          </button>
        </div>
        <div style={s.bbDiffBody}>
          <div style={s.bbDiffFiles}>
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                style={selected === file.path ? s.bbDiffFileActive : s.bbDiffFile}
                onClick={() => void selectFile(file.path)}
              >
                <span>{file.path}</span>
                <span style={s.bbBadgeDone}>+{file.additions}</span>
                <span style={s.bbBadgeConflict}>-{file.deletions}</span>
              </button>
            ))}
          </div>
          <div style={s.bbDiffPane}>
            {diff.split("\n").map((line, i) => (
              <div key={i} style={lineStyle(line)}>
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

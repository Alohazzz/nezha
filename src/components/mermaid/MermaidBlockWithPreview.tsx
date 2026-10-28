import { useCallback, useState } from "react";
import { MermaidBlock } from "./MermaidBlock";
import { MermaidPreviewDialog } from "./MermaidPreviewDialog";

/** MermaidBlock + 放大预览的最小组合：各消息视图直接复用，无需各自管 dialog 状态。 */
export function MermaidBlockWithPreview({ code }: { code: string }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSvg, setPreviewSvg] = useState<string | null>(null);
  const handlePreviewSvgChange = useCallback((svg: string | null) => setPreviewSvg(svg), []);
  return (
    <>
      <MermaidBlock
        code={code}
        onOpenPreview={() => setPreviewOpen(true)}
        onPreviewSvgChange={handlePreviewSvgChange}
      />
      <MermaidPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} svg={previewSvg} />
    </>
  );
}

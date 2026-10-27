import { useState } from "react";
import { ImageLightbox } from "../common/ImageLightbox";
import s from "../../styles";

interface PastedImage {
  id: string;
  dataUrl: string;
}

export function ImageAttachments({
  images,
  onRemove,
}: {
  images: PastedImage[];
  onRemove: (id: string) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  if (images.length === 0) return null;

  const preview = images.find((img) => img.id === previewId) ?? null;
  return (
    <>
      {images.map((img) => (
        <div key={img.id} style={s.imageAttachmentItem}>
          <img
            src={img.dataUrl}
            style={s.imageAttachmentImg}
            onClick={() => setPreviewId(img.id)}
            className="image-attachment-thumb"
          />
          <button onClick={() => onRemove(img.id)} style={s.imageAttachmentRemove}>
            ✕
          </button>
        </div>
      ))}
      {preview && <ImageLightbox src={preview.dataUrl} onClose={() => setPreviewId(null)} />}
    </>
  );
}
